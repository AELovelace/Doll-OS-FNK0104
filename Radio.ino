//   Radio.ino
//   Background internet-radio player on the board's onboard ES8311 codec + speaker,
//   ported from the standalone sgcrelay firmware (../sgcrelay/sgcrelay.ino). What
//   carried over: the codec/I2S bring-up sequence (verbatim from Freenove's
//   Sketch_07.1_Music via sgcrelay), the ESP32-audioI2S streaming, and the
//   retry-with-backoff reconnect logic. What didn't: sgcrelay's LovyanGFX touch UI
//   (this panel belongs to Display.ino's TFT_eSPI mirror -- volume is a shell
//   command now), its Wi-Fi handling (WiFiManager.ino owns STA), and the WS2812/
//   BOOT-button controls (redundant with the shell).
//
//   Unlike sgcrelay, playback does NOT run on the main loop: DOLL-OS's modal sessions
//   (ssh, outbound telnet) monopolize loop() for their whole duration and
//   drawDisplayFrame()'s full-frame SPI push adds jitter, so audio.loop() is pumped
//   from a dedicated long-lived FreeRTOS task (same pattern as Ssh.ino's, but
//   persistent). The shell talks to the task through a one-slot command mailbox and
//   the task publishes status back through fixed-size shared buffers -- both guarded
//   by radioMux. ESP32-audioI2S's weak callbacks (audio_showstreamtitle etc.) fire
//   in the *task's* context, so they must never call outLine() themselves (it writes
//   the telnet socket and display history the main loop owns); they stash an
//   announcement instead, which radioService() (called every loop() tick) prints.
//
//   Pin note: the codec's control bus is I2C SDA=16/SCL=15 -- PCB-routed, not
//   movable, and the reason the DS-Slave serial link vacated those pins for
//   GPIO21/2 (see KeyboardSerial.ino). Values below are the FNK0104AB variant's,
//   from Freenove's Sketch_07.1_Music; the N/S variants use different I2S/I2C pins
//   (see that sketch's alternate pin block) and haven't been wired up here.

#include "Audio.h"
#include "ESP_I2S.h"
#include <Wire.h>
#include <new>   //std::nothrow -- radioEnsureCodec heap-constructs the Audio engine
#include "es8311.h"

//   ES8311 codec / I2S pins (FNK0104AB)
#define RADIO_I2S_MCK 4
#define RADIO_I2S_BCK 5
#define RADIO_I2S_DINT 6
#define RADIO_I2S_DOUT 8
#define RADIO_I2S_WS 7
#define RADIO_AMP_ENABLE 1        //driven low = amp on, matching Freenove's example
#define RADIO_I2C_SCL 15
#define RADIO_I2C_SDA 16
#define RADIO_I2C_SPEED 400000

//RADIO_VOLUME_MAX lives in global.h -- Gameboy.ino's settings menu shows the level
//too, and the .ino files concatenate alphabetically, so Gameboy.ino is compiled
//above this file and can't see a constant defined here.
const unsigned long RADIO_STREAM_RETRY_MS = 5000;
const int RADIO_TASK_STACK_SIZE = 12288;     //MP3 decode runs on this stack (audio.loop())

//   one-slot command mailbox, shell -> task (kinds: RadioCommandKind, global.h).
//   A second command before the task consumed the first simply overwrites it --
//   single-user shell, latest wins.
static portMUX_TYPE radioMux = portMUX_INITIALIZER_UNLOCKED;
static RadioCommandKind radioCmdKind = RADIO_CMD_NONE;
static char radioCmdUrl[256] = "";
static int radioCmdVolume = 0;

//   status published by the task, snapshotted by the shell/service under radioMux.
//   Fixed char buffers, not Strings: a String copy allocates, and allocating inside
//   a spinlock critical section is asking for trouble.
static RadioState radioState = RADIO_OFF;
static char radioTitle[128] = "";            //ICY StreamTitle (or station name until one arrives)
static char radioUrl[256] = "";              //last URL played, reused by a bare "radio play"
static int radioVolume = RADIO_DEFAULT_VOLUME;
static char radioAnnounceText[160] = "";     //one pending line for radioService() to print
static int radioAnnounceColor = C_WHITE;
static bool radioAnnouncePending = false;

static bool radioDefaultsInitialized = false;

//Runs once, lazily, the first time "radio" is used post-boot. radioVolume's static
//initializer above runs at global-construction time, before LittleFS is mounted, so
//a "settings set radio.volume" override can't be read there -- it has to be applied
//here instead (same lazy-init shape as Asuka.ino's asukaEnsureDefaults()).
static void radioEnsureDefaults() {
    if (radioDefaultsInitialized) {
        return;
    }
    radioDefaultsInitialized = true;
    int savedVolume = settingsGet("radio.volume", String(RADIO_DEFAULT_VOLUME)).toInt();
    if (savedVolume < 0 || savedVolume > RADIO_VOLUME_MAX) {
        return;
    }
    portENTER_CRITICAL(&radioMux);
    radioVolume = savedVolume;
    portEXIT_CRITICAL(&radioMux);
}

static TaskHandle_t radioTaskHandle = NULL;

//   task-local -- only the radio task touches these after creation.
//   radioAudio is heap-constructed lazily on the first "radio play" (radioEnsureCodec)
//   rather than being a global: ESP32-audioI2S's constructor immediately allocates the
//   I2S channel's DMA buffers (~28KB of DMA-capable *internal* RAM -- PSRAM can't serve
//   DMA) and spawns its decode task, and as a global that all happened before setup(),
//   starving the WiFi stack's bring-up of internal RAM (seen as an esp-sha OOM -> crash
//   in ieee80211_hostap_attach, back when DOLL-OS still ran a softAP). Deferring it means the
//   cost is only paid after WiFi is up,
//   and only if the radio is actually used.
static Audio* radioAudio = nullptr;
static I2SClass radioI2s;
static bool radioCodecReady = false;
static bool radioI2sReady = false;           //radioI2s.begin() has claimed its I2S controller -- must
                                              //only ever happen once: the S3 has two controllers total
                                              //(one for this bootstrap channel, one for Audio), and a
                                              //re-begin on a retry would leak a fresh one, starving Audio
static volatile bool radioReleased = false;  //set by the task once RADIO_CMD_RELEASE has torn the
                                              //I2S controllers down -- radioReleaseAudio() waits on it
static bool radioWantPlaying = false;        //user intent: keep the stream up (drives auto-reconnect)
static bool radioPaused = false;
static unsigned long radioLastAttemptMs = 0;

//---------------------------------------------------------------------------
//task side

//stash one line for the main loop to print -- safe to call from the task/callbacks,
//where outLine() is not
static void radioAnnounce(const char* text, int color) {
    portENTER_CRITICAL(&radioMux);
    strncpy(radioAnnounceText, text, sizeof(radioAnnounceText) - 1);
    radioAnnounceText[sizeof(radioAnnounceText) - 1] = '\0';
    radioAnnounceColor = color;
    radioAnnouncePending = true;
    portEXIT_CRITICAL(&radioMux);
}

static void radioSetState(RadioState s) {
    portENTER_CRITICAL(&radioMux);
    radioState = s;
    portEXIT_CRITICAL(&radioMux);
    ledSetRadioState(s);
}

//quick bus census so a codec failure says *why* on the serial log: prints every ACKing
//address. The FT6336U touch (0x38) shares this PCB-routed bus, so its presence/absence
//splits the diagnosis -- 0x38 answering but no 0x18/0x19 means the bus is fine and the
//codec specifically isn't responding; a silent bus points at wiring/pull-ups/pin conflict.
static void radioScanI2cBus() {
    Serial.println("[radio] I2C scan (SDA=16 SCL=15):");
    int found = 0;
    esp_log_level_set("i2c.master", ESP_LOG_NONE);   //~100 expected NACKs -- don't let the driver's
                                                      //error spam bury the scan's own output
    for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("[radio]   device ACK at 0x%02X\n", addr);
            found++;
        }
    }
    esp_log_level_set("i2c.master", ESP_LOG_ERROR);
    if (found == 0) {
        Serial.println("[radio]   no devices ACKed -- bus dead? (wiring, pull-ups, pin conflict)");
    }
}

//Amp + I2C + ES8311 register programming, once. Split out of radioEnsureCodec so the
//Game Boy emulator's audio path (src/AudioOut.cpp) can reuse it: that path brings up
//its own I2S TX channel but needs the same codec configured behind it, and calling
//es8311_codec_init() twice would leak a handle. es8311.cpp's register helpers use Wire
//(see the driver_ng note there), so Wire.begin below is the only prerequisite --
//nothing else in DOLL-OS touches I2C.
//
//Caller must already have clocks on the I2S pins: the codec is a slave and wants MCLK
//running while its dividers are programmed. Not static -- AudioOut.cpp declares it.
bool audioCodecEnsure() {
    static bool codecRegsReady = false;
    if (codecRegsReady) {
        return true;
    }

    pinMode(RADIO_AMP_ENABLE, OUTPUT);
    digitalWrite(RADIO_AMP_ENABLE, LOW);

    if (!Wire.begin(RADIO_I2C_SDA, RADIO_I2C_SCL, RADIO_I2C_SPEED)) {
        Serial.println("[audio] I2C init failed");
        return false;
    }

    if (es8311_codec_init() != ESP_OK) {
        radioScanI2cBus();   //serial-only: says whether anything at all answers on the bus
        Serial.println("[audio] ES8311 codec init failed");
        return false;
    }

    codecRegsReady = true;
    Serial.println("[audio] ES8311 codec up");
    return true;
}

//codec + I2S bring-up, once, lazily on the first "radio play" -- the exact sequence
//sgcrelay's driver_es8311_init()/setup() ran, minus the parts DOLL-OS already owns.
static bool radioEnsureCodec() {
    if (radioCodecReady) {
        return true;
    }

    if (!radioI2sReady) {
        radioI2s.setPins(RADIO_I2S_BCK, RADIO_I2S_WS, RADIO_I2S_DOUT, RADIO_I2S_DINT, RADIO_I2S_MCK);
        if (!radioI2s.begin(I2S_MODE_STD, 44100, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_LEFT)) {
            radioAnnounce("radio: I2S init failed", C_RED);
            return false;
        }
        radioI2sReady = true;
    }

    if (!audioCodecEnsure()) {
        radioAnnounce("radio: ES8311 codec init failed (see serial log)", C_RED);
        return false;
    }

    if (radioAudio == nullptr) {
        //port 1 explicitly: Audio's default is I2S_NUM_0 *by name*, but radioI2s.begin above
        //(I2S_NUM_AUTO) has already claimed port 0 by the time we construct lazily -- in
        //sgcrelay the global Audio constructed first and the default happened to fit
        radioAudio = new (std::nothrow) Audio(I2S_NUM_1);
        if (radioAudio == nullptr) {
            radioAnnounce("radio: out of memory for audio engine", C_RED);
            return false;
        }
    }

    //setPinout fails if the ctor couldn't get an I2S controller (or the reconfig itself
    //fails) -- tear the engine back down so the next attempt starts from a clean slate
    //instead of driving a NULL channel handle
    if (!radioAudio->setPinout(RADIO_I2S_BCK, RADIO_I2S_WS, RADIO_I2S_DOUT, RADIO_I2S_MCK)) {
        delete radioAudio;
        radioAudio = nullptr;
        radioAnnounce("radio: audio engine could not attach I2S", C_RED);
        return false;
    }
    //v3.4.x delivers titles/station/eof/info through this one callback (radioAudioInfo).
    //It's a static member, so registering once is enough -- do it before any connect.
    Audio::audio_info_callback = radioAudioInfo;
    //cap the blocking connect so an unreachable host can't hold this task (core 1, prio
    //above loopTask) past the ~5s task-watchdog window and reset the board.
    radioAudio->setConnectionTimeout(3000, 4000);
    radioAudio->setVolume(radioVolume);

    radioCodecReady = true;
    return true;
}

static void radioConnect(const char* url) {
    radioSetState(RADIO_CONNECTING);
    radioLastAttemptMs = millis();
    Serial.printf("[radio] connecting: %s\n", url);
    radioAudio->connecttohost(url);
}

static void radioTaskHandleCommand() {
    //snapshot + clear the mailbox under the lock, act on it outside
    portENTER_CRITICAL(&radioMux);
    RadioCommandKind kind = radioCmdKind;
    char url[sizeof(radioCmdUrl)];
    strcpy(url, radioCmdUrl);
    int volume = radioCmdVolume;
    radioCmdKind = RADIO_CMD_NONE;
    portEXIT_CRITICAL(&radioMux);

    switch (kind) {
        case RADIO_CMD_NONE:
            break;
        case RADIO_CMD_PLAY:
            if (!radioEnsureCodec()) {
                radioSetState(RADIO_ERROR);
                break;
            }
            radioWantPlaying = true;
            radioPaused = false;
            radioConnect(url);
            break;
        case RADIO_CMD_PAUSE:
            if (!radioWantPlaying || radioAudio == nullptr) {
                break;
            }
            radioAudio->pauseResume();
            radioPaused = !radioAudio->isRunning();
            radioSetState(radioPaused ? RADIO_PAUSED : RADIO_PLAYING);
            radioAnnounce(radioPaused ? "radio: paused" : "radio: resumed", C_PINK);
            break;
        case RADIO_CMD_STOP:
            radioWantPlaying = false;
            radioPaused = false;
            if (radioAudio != nullptr) {
                radioAudio->stopSong();
            }
            radioSetState(RADIO_STOPPED);
            radioAnnounce("radio: stopped", C_PINK);
            break;
        case RADIO_CMD_VOLUME:
            if (radioAudio != nullptr) {
                radioAudio->setVolume(volume);
            }
            break;
        case RADIO_CMD_RELEASE:
            //Give both I2S controllers back (see radioReleaseAudio). Done here, on the
            //task, rather than by the caller: radioAudio is task-local and audio.loop()
            //is running on this stack -- deleting the engine from the main loop would
            //race the decoder mid-frame.
            radioWantPlaying = false;
            radioPaused = false;
            if (radioAudio != nullptr) {
                radioAudio->stopSong();
                delete radioAudio;
                radioAudio = nullptr;
            }
            if (radioI2sReady) {
                radioI2s.end();
                radioI2sReady = false;
            }
            //codec *registers* stay programmed (audioCodecEnsure keeps its own latch);
            //only the streaming side has to be rebuilt on the next "radio play"
            radioCodecReady = false;
            radioSetState(RADIO_STOPPED);
            radioReleased = true;
            break;
    }
}

//long-lived task: pumps the decoder, consumes shell commands, and keeps the stream
//up (reconnect with backoff) whenever the user's intent is "playing" -- mirrors
//sgcrelay's loop(), which this task replaces
static void radioTaskEntry(void* pvParameters) {
    (void)pvParameters;
    while (true) {
        radioTaskHandleCommand();
        if (radioAudio != nullptr) {
            radioAudio->loop();
        }

        if (radioWantPlaying && !radioPaused) {
            if (radioAudio->isRunning()) {
                radioSetState(RADIO_PLAYING);
            } else if (WiFi.status() == WL_CONNECTED
                       && millis() - radioLastAttemptMs > RADIO_STREAM_RETRY_MS) {
                Serial.println("[radio] stream not running, retrying...");
                char url[sizeof(radioUrl)];
                portENTER_CRITICAL(&radioMux);
                strcpy(url, radioUrl);
                portEXIT_CRITICAL(&radioMux);
                radioConnect(url);
            }
        }

        vTaskDelay(1);   //yield so the core-1 idle task still runs (watchdog) -- the
                          //decoder's internal buffering rides out far longer gaps
    }
}

//---------------------------------------------------------------------------
//ESP32-audioI2S status callback. As of v3.4.x the library funnels every event
//(the old weak audio_info/audio_showstreamtitle/audio_showstation/audio_eof_stream
//free functions are gone) through one std::function<void(msg_t)>, registered in
//radioEnsureCodec. It fires inside the radio task (audio.loop()'s caller), so the
//same rule as before holds: radioAnnounce()/shared-buffer writes and Serial only --
//never outLine(). m.msg points at a library scratch buffer valid only for this call,
//so anything kept is copied out synchronously here.
void radioAudioInfo(Audio::msg_t m) {
    const char* text = (m.msg != nullptr) ? m.msg : "";
    switch (m.e) {
        case Audio::evt_streamtitle: {
            portENTER_CRITICAL(&radioMux);
            strncpy(radioTitle, text, sizeof(radioTitle) - 1);
            radioTitle[sizeof(radioTitle) - 1] = '\0';
            portEXIT_CRITICAL(&radioMux);
            String line = "radio: now playing: " + String(text);
            radioAnnounce(line.c_str(), C_CYAN);
            break;
        }
        case Audio::evt_name: {
            //station name -- placeholder until the first ICY StreamTitle arrives
            portENTER_CRITICAL(&radioMux);
            if (radioTitle[0] == '\0') {
                strncpy(radioTitle, text, sizeof(radioTitle) - 1);
                radioTitle[sizeof(radioTitle) - 1] = '\0';
            }
            portEXIT_CRITICAL(&radioMux);
            Serial.printf("[radio] station: %s\n", text);
            break;
        }
        case Audio::evt_eof:
            Serial.printf("[radio] stream ended: %s\n", text);
            radioSetState(RADIO_ERROR);
            //no announce -- the task's reconnect logic retries on its own; only the
            //user-visible state (radio status) reflects the hiccup
            break;
        default:
            //evt_info / evt_log / bitrate / icy-url etc. -- serial trace, as audio_info did
            Serial.printf("[radio] %s\n", text);
            break;
    }
}

//---------------------------------------------------------------------------
//main-loop side

//called every loop() tick (DS.ino): prints whatever the task/callbacks stashed.
//This is the only place radio output enters the telnet socket + display mirror,
//keeping both single-writer (the main loop).
void radioService() {
    if (!radioAnnouncePending) {   //racy peek is fine -- worst case we print next tick
        return;
    }
    char text[sizeof(radioAnnounceText)];
    int color;
    portENTER_CRITICAL(&radioMux);
    strcpy(text, radioAnnounceText);
    color = radioAnnounceColor;
    radioAnnouncePending = false;
    portEXIT_CRITICAL(&radioMux);
    outLine(String(text), color);
}

static void radioPostCommand(RadioCommandKind kind, const char* url, int volume) {
    portENTER_CRITICAL(&radioMux);
    radioCmdKind = kind;
    if (url != NULL) {
        strncpy(radioCmdUrl, url, sizeof(radioCmdUrl) - 1);
        radioCmdUrl[sizeof(radioCmdUrl) - 1] = '\0';
        strcpy(radioUrl, radioCmdUrl);
    }
    radioCmdVolume = volume;
    portEXIT_CRITICAL(&radioMux);
}

static bool radioEnsureTask() {
    if (radioTaskHandle != NULL) {
        return true;
    }
    //same core as the ssh task (portNUM_PROCESSORS - 1); priority above the loop
    //task (1) so decode keeps up, below ssh's +3 so an active ssh session stays
    //responsive during its short lifetime
    BaseType_t created = xTaskCreatePinnedToCore(radioTaskEntry, "radioTask", RADIO_TASK_STACK_SIZE,
        NULL, (tskIDLE_PRIORITY + 2), &radioTaskHandle, portNUM_PROCESSORS - 1);
    if (created != pdPASS) {
        radioTaskHandle = NULL;
        outLine("radio: could not start playback task (out of memory)", C_RED);
        return false;
    }
    return true;
}

static const char* radioStateName(RadioState s) {
    switch (s) {
        case RADIO_OFF:        return "off";
        case RADIO_CONNECTING: return "connecting";
        case RADIO_PLAYING:    return "playing";
        case RADIO_PAUSED:     return "paused";
        case RADIO_STOPPED:    return "stopped";
        case RADIO_ERROR:      return "error (retrying)";
    }
    return "?";
}

static void radioPrintStatus() {
    portENTER_CRITICAL(&radioMux);
    RadioState state = radioState;
    char title[sizeof(radioTitle)];
    strcpy(title, radioTitle);
    char url[sizeof(radioUrl)];
    strcpy(url, radioUrl);
    int volume = radioVolume;
    portEXIT_CRITICAL(&radioMux);

    outLine("");
    outLine("Radio status", C_CYAN);
    outLine("------------");
    outLine("State: " + String(radioStateName(state)));
    if (url[0] != '\0') {
        outLine("Stream: " + String(url));
    }
    if (title[0] != '\0') {
        outLine("Now playing: " + String(title));
    }
    outLine("Volume: " + String(volume) + "/" + String(RADIO_VOLUME_MAX));
    outLine("");
}

//Hand the audio hardware to something else -- currently only the Game Boy emulator
//(Gameboy.ino -> src/AudioOut.cpp), which needs one of the S3's two I2S controllers
//and can't have one while the radio holds both (a bootstrap channel for MCLK plus
//ESP32-audioI2S's). Stops any stream, deletes the engine, frees the controllers.
//Nothing is auto-restored: the next "radio play" walks radioEnsureCodec again and
//rebuilds what it needs, which by then is free because the game called AudioOut::end().
//
//Blocks until the task confirms (it polls the mailbox every tick, so this is
//milliseconds); the timeout is only so a wedged radio task can't hang the shell.
//Returns true if the hardware is actually free.
bool radioReleaseAudio() {
    if (radioTaskHandle == NULL) {
        return true;   //task never started -- nothing was ever claimed
    }
    radioReleased = false;
    radioPostCommand(RADIO_CMD_RELEASE, NULL, 0);
    for (int waited = 0; waited < 2000 && !radioReleased; waited += 10) {
        delay(10);
    }
    return radioReleased;
}

//current volume, snapshotted under the mux -- the status bar (Display.ino's
//drawDisplayStatusBar) reads this each refresh instead of us printing a line on change.
int radioGetVolume() {
    int volume;
    portENTER_CRITICAL(&radioMux);
    volume = radioVolume;
    portEXIT_CRITICAL(&radioMux);
    return volume;
}

//relative volume nudge for the Ctrl+Up/Down chords (TelnetServer.ino's handleCsiSequence,
//RemoteSession.ino's raw-session escape handling) -- clamps instead of validating a typed
//number, otherwise identical to the "radio vol <n>" branch below. The new level shows in
//the status bar (VOL:xx), so there's no line printed here.
void radioAdjustVolume(int delta) {
    int volume;
    portENTER_CRITICAL(&radioMux);
    volume = radioVolume + delta;
    if (volume < 0) {
        volume = 0;
    } else if (volume > RADIO_VOLUME_MAX) {
        volume = RADIO_VOLUME_MAX;
    }
    radioVolume = volume;
    portEXIT_CRITICAL(&radioMux);
    if (radioTaskHandle != NULL) {
        radioPostCommand(RADIO_CMD_VOLUME, NULL, volume);
    }
}

//Expected forms: radio | radio status | radio play [url] | radio pause | radio stop | radio vol <0-21>
void handleRadioCommand(const String parts[], int partCount) {
    radioEnsureDefaults();
    String sub = (partCount > 1) ? parts[1] : "status";

    if (sub == "status") {
        radioPrintStatus();
        return;
    }

    if (sub == "play") {
        if (WiFi.status() != WL_CONNECTED) {
            outLine("radio: WiFi not connected. Run 'wifi connect' first.", C_RED);
            return;
        }
        String url;
        if (partCount > 2) {
            url = parts[2];
        } else {
            portENTER_CRITICAL(&radioMux);
            url = String(radioUrl);
            portEXIT_CRITICAL(&radioMux);
            if (url.length() == 0) {
                url = settingsGet("radio.url", RADIO_DEFAULT_URL);
            }
        }
        if (!radioEnsureTask()) {
            return;
        }
        radioPostCommand(RADIO_CMD_PLAY, url.c_str(), 0);
        outLine("radio: connecting to " + url, C_PINK);
        return;
    }

    if (sub == "pause") {
        if (radioTaskHandle == NULL) {
            outLine("radio: not playing");
            return;
        }
        radioPostCommand(RADIO_CMD_PAUSE, NULL, 0);
        return;
    }

    if (sub == "stop") {
        if (radioTaskHandle == NULL) {
            outLine("radio: not playing");
            return;
        }
        radioPostCommand(RADIO_CMD_STOP, NULL, 0);
        return;
    }

    if (sub == "vol") {
        if (partCount < 3) {
            outLine("Usage: radio vol <0-" + String(RADIO_VOLUME_MAX) + ">");
            return;
        }
        int volume = parts[2].toInt();
        if (volume < 0 || volume > RADIO_VOLUME_MAX
            || (volume == 0 && parts[2] != "0")) {
            outLine("Usage: radio vol <0-" + String(RADIO_VOLUME_MAX) + ">");
            return;
        }
        portENTER_CRITICAL(&radioMux);
        radioVolume = volume;
        portEXIT_CRITICAL(&radioMux);
        if (radioTaskHandle != NULL) {
            radioPostCommand(RADIO_CMD_VOLUME, NULL, volume);
        }
        return;
    }

    outLine("Usage: radio [status|play [url]|pause|stop|vol <0-" + String(RADIO_VOLUME_MAX) + ">]");
}
