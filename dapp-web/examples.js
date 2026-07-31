export const examples = {
  hello: {
    name: "hello, browser",
    source: `# Your first .dapp
COLOR cyan
PRINT "hello from a tiny program"
WAIT 350

COLOR white
INPUT name "what should I call you? "
PRINT ""
COLOR pink
PRINT "hi, $name. you made this run."

RAND lucky 1 100
COLOR yellow
PRINT "your lucky number is $lucky"
EXIT`
  },

  branching: {
    name: "midnight vending machine",
    source: `# A choice, a variable, and a small amount of dread.
SET coins 3

:menu
COLOR pink
PRINT "+------------------------------+"
PRINT "  MIDNIGHT VENDING MACHINE"
PRINT "+------------------------------+"
COLOR white
PRINT "you have $coins coins"
PRINT ""
PRINT "1. mystery soda (2)"
PRINT "2. questionable chips (1)"
PRINT "3. walk away"
INPUT choice "> "

IFEQ $choice 1 GOTO soda
IFEQ $choice 2 GOTO chips
IFEQ $choice 3 GOTO leave
COLOR red
PRINT "the machine does not understand."
GOTO menu

:soda
IF $coins < 2 GOTO broke
SUB coins 2
COLOR cyan
PRINT "it tastes like television static."
GOTO menu

:chips
IF $coins < 1 GOTO broke
SUB coins 1
COLOR yellow
PRINT "mostly air. spiritually filling."
GOTO menu

:broke
COLOR red
PRINT "the machine blinks: INSUFFICIENT YEARNING"
GOTO menu

:leave
COLOR green
PRINT "you keep $coins coins and your dignity."
END`
  },

  canvas: {
    name: "canvas postcard",
    source: `# CANVAS gives you a fixed character grid.
CANVAS 38 12
CLS

COLOR pink
PUT 3 1 "+------------------------------+"
PUT 3 10 "+------------------------------+"
COLOR cyan
PUT 10 4 "HELLO FROM THE VOID"
COLOR yellow
PUT 13 6 "*  *  *  *"
COLOR white
PUT 9 8 "tiny apps live here :)"
FLIP
WAIT 1800

ENDCANVAS
COLOR green
PRINT "postcard delivered."
END`
  },

  files: {
    name: "browser-local guestbook",
    source: `# Files are sandboxed in this browser's local storage.
INPUT name "sign the guestbook: "
FOPEN "/apps/guestbook.txt" append
IF $fok = 0 GOTO fail
FWRITE "$name was here"
FCLOSE

COLOR cyan
PRINT "guestbook so far:"
FOPEN "/apps/guestbook.txt" read
:read
FREAD line
IF $feof = 1 GOTO done
COLOR white
PRINT " - $line"
GOTO read

:done
FCLOSE
END

:fail
COLOR red
PRINT "could not open the guestbook"
END`
  },

  llm: {
    name: "LLM chat via same-origin proxy",
    source: `# The website hosting this runner must proxy this path to your LLM.
# Never put a production API key in a public web page.
SETSTR endpoint "/v1/chat/completions"
SETSTR model "local-model"
CHR q 34
HTTPHEADER "Content-Type" "application/json"

:chat
INPUT prompt "you> "
IFEQ $prompt "/quit" GOTO done
JSONESC safe $prompt
SETSTR body "{"
APPEND body $q
APPEND body "model$q:"
APPEND body $q
APPEND body "$model$q,"
APPEND body $q
APPEND body "messages$q:[{"
APPEND body $q
APPEND body "role$q:"
APPEND body $q
APPEND body "user$q,"
APPEND body $q
APPEND body "content$q:"
APPEND body $q
APPEND body $safe
APPEND body $q
APPEND body "}] }"
HTTPPOST raw $endpoint $body 4096
IF $httpok = 0 GOTO failed
JSONGET answer $raw "choices[0].message.content"
IF $jsonok = 0 GOTO failed
COLOR cyan
PRINT "llm> $answer"
COLOR white
GOTO chat
:failed
COLOR red
PRINT "request failed: HTTP $httpcode"
COLOR white
GOTO chat
:done
END`
  }
};

export const commandGroups = [
  {
    title: "OUTPUT + TIME",
    commands: [
      ["PRINT text", "Print a line with $variables expanded. ECHO is an alias."],
      ["COLOR name", "Set white, red, green, yellow, blue, magenta, cyan, pink, or black."],
      ["CLEAR", "Clear terminal output, or blank the active canvas. CLS is an alias."],
      ["WAIT ms", "Pause in milliseconds. SLEEP is an alias."],
      ["INPUT name prompt", "Wait for a line of text and store it as a string."],
      ["INPUTSECRET name prompt", "Read masked text for a token or password."]
    ]
  },
  {
    title: "NUMBERS + TEXT",
    commands: [
      ["SET name value", "Set an integer variable."],
      ["ADD / SUB / MUL", "Change an integer variable by a value."],
      ["DIV / MOD", "Integer division or remainder."],
      ["EXPR name expression", "Evaluate arithmetic with + - * / % ^ and math functions."],
      ["RAND name max", "Random 0..max-1. Add min before max for an inclusive range."],
      ["SETSTR / APPEND", "Create or extend a string variable."],
      ["LEN / CHARAT", "Measure text or read a character code."],
      ["CHR / SUBSTR", "Create a character or slice a string."],
      ["HEX name value width", "Format an integer as 1..8 uppercase hexadecimal digits."],
      ["JSONESC name text", "Escape text so it is safe inside a JSON string."],
      ["JSONGET name json path", "Read a value such as choices[0].message.content."]
    ]
  },
  {
    title: "FLOW",
    commands: [
      [":label", "Define a target. LABEL name also works."],
      ["GOTO label", "Jump to a label."],
      ["GOSUB / RETURN", "Call a label and return to the instruction after the call."],
      ["IF l op r GOTO label", "Numeric comparison: = == != <> < <= > >=. GOSUB also works."],
      ["IFEQ / IFNE", "Compare text, then GOTO or GOSUB."],
      ["EXIT", "Stop the app. END is an alias."]
    ]
  },
  {
    title: "ARRAYS + KEYS + CANVAS",
    commands: [
      ["DIM name size", "Create a zero-filled numeric array."],
      ["KEY name", "Read one key code now, or 0. Arrow constants include $kleft and $kup."],
      ["LED r g b", "Set rear LED color channels (runtime >=1.3.0). Check $ledok before using on-device."],
      ["WAVE ch kind hz level", "Mix sine, triangle, square, or noise on one of three channels."],
      ["WAVESTOP", "Silence all synth channels."],
      ["CANVAS cols rows", "Open a fixed character grid, up to 120 x 60."],
      ["PUT x y text", "Place colored text in the canvas buffer."],
      ["FLIP / ENDCANVAS", "Show the buffered frame or return to terminal output."]
    ]
  },
  {
    title: "BROWSER FILES",
    commands: [
      ["FOPEN path mode", "Open one sandboxed file for read, write, append, or update."],
      ["FREAD / FWRITE", "Read into a string or write one expanded line."],
      ["FREADB / FWRITEB", "Read or write one raw byte without newline or NUL damage."],
      ["FSEEK / FTELL / FSIZE", "Navigate an open file by byte offset."],
      ["FCLOSE", "Close the current file."],
      ["FEXISTS name path", "Store 1 when a sandboxed file exists."],
      ["FDELETE path", "Delete a file. $fok reports success."],
      ["HTTPCLEAR / HTTPHEADER", "Clear or set up to eight request headers."],
      ["HTTPGET name url max", "Fetch a bounded HTTP/HTTPS text body; inspect $httpok and $httpcode."],
      ["HTTPPOST name url body max", "POST a bounded text body and capture the bounded response."]
    ]
  }
];
