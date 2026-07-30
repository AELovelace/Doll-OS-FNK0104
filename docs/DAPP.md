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
LABEL <name>        define a jump target
:<name>             shorthand label
GOTO <name>         jump to a label
IF <l> <op> <r> GOTO <name>
EXIT                leave the app
END                 alias for EXIT
```

`IF` supports `=`, `==`, `!=`, `<>`, `<`, `<=`, `>`, and `>=`.

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

