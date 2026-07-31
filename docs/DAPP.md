# DS .dapp Apps

`.dapp` files are text executables for the DS shell. Upload them to the SD card
with FTP, preferably under:

```text
/apps
```

From DS, the same folder appears as:

```text
/sd/apps
```

Use:

```text
apps
run hello
run /sd/apps/hello.dapp
```

## Example

```text
# /sd/apps/hello.dapp
COLOR cyan
PRINT "hello from a DS app"
PRINT "cwd=$cwd ip=$ip battery=$battery%"
INPUT name "name> "
PRINT "hi, $name"
RAND lucky 1 100
PRINT "lucky number: $lucky"
WAIT 750
COLOR pink
PRINT "tiny executable acquired"
EXIT
```

## Commands

```text
PRINT <text>        print text, with $variables expanded
ECHO <text>         alias for PRINT
COLOR <name>        white, red, green, yellow, blue, magenta, cyan, pink
CLEAR               clear terminal/display history
CLS                 alias for CLEAR
WAIT <ms>           pause while keeping display/radio/FTP serviced
SLEEP <ms>          alias for WAIT
SET <name> <value>  set a numeric variable
ADD <name> <value>  add to a numeric variable
RAND <n> <max>      set numeric variable n to 0..max-1
RAND <n> <min> <max> set numeric variable n to min..max
SETSTR <name> <txt> set a string variable
APPEND <name> <txt> append to a string variable
INPUT <name> [p]    read a line into a string variable
LABEL <name>        define a jump target
:<name>             shorthand label
GOTO <name>         jump to a label
IF <l> <op> <r> GOTO <name>
IFEQ <l> <r> GOTO <name>
IFNE <l> <r> GOTO <name>
EXIT                leave the app
END                 alias for EXIT
```

`IF` supports `=`, `==`, `!=`, `<>`, `<`, `<=`, `>`, and `>=`.
`RAND roll 6` returns `0..5`; `RAND roll 1 6` returns `1..6`.
`IFEQ` and `IFNE` compare strings. Quote string literals that contain spaces.
String variables are capped at 512 characters each.

Built-ins usable as `$name` or numeric values:

```text
$battery
$cwd
$heap
$ip
$millis
$seconds
$wifi
```

## Interactive Example

```text
# /sd/apps/ask.dapp
COLOR pink
PRINT "tiny prompt"

:again
INPUT reply "say> "
IFEQ $reply "/quit" GOTO done
PRINT "you said: $reply"
GOTO again

:done
PRINT "bye"
EXIT
```
