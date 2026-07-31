# The .dapp Book

*Learning to program the DOLL-OS shell, one tiny executable at a time.*

---

A `.dapp` file is a plain text program that the DOLL-OS shell runs with the `run`
command. The language is small on purpose: about forty commands, numbers,
strings, arrays, and jumps. Small does not mean weak — by the end of this book
you will have built Tetris in it — but it does mean *learnable*. Every command
fits on one line, every program is a text file you can read top to bottom, and
nothing is hiding anywhere.

**How to use this book.** Each chapter teaches a handful of commands, shows
them working, and ends with practice problems. Type the examples in — really
type them; that is where the learning happens. Answers to the practice problems
are in Appendix D, but wrestle with them first. The last three chapters are the
payoff: a full walkthrough of the Tetris that ships on this device, a real app
that talks to an LLM over `/v1/chat/completions`, and then teaching Tetris to
remember its high score after the power goes out.

---

## Chapter 0 — Getting Set Up

Apps live in two places:

```text
/sd/apps   on the SD card (upload over FTP into /apps)
/apps      on internal flash
```

Three shell commands are your whole toolchain:

```text
apps                     list installed .dapp files
edit /sd/apps/first.dapp write or change a program, ^O saves, ^X exits
run first                run it
```

`run` finds an app by bare name in `/sd/apps` then `/apps`, or takes a full
path. The `edit` command syntax-highlights `.dapp` files: commands turn cyan,
labels pink, strings green, `$variables` yellow, numbers orange. **If an opcode
stays white, `run` will reject it** — the highlighter and the interpreter agree
about what is a command, which makes the colors a free spell-checker.

Create `/sd/apps/first.dapp` with `edit`, put `PRINT "hello"` in it, save, and
`run first`. If you see hello, your toolchain works and you are a DOLL-OS programmer
now. The rest is vocabulary.

---

## Chapter 1 — Hello, DOLL-OS

### 1.1 PRINT and ECHO

`PRINT` writes one line to the terminal (and to the panel, which mirrors it):

```text
PRINT "hello from a DOLL-OS app"
PRINT hello too
ECHO "same thing, different name"
```

Quotes are optional unless you care about exact spacing — a quoted string keeps
its leading and trailing spaces, a bare one is trimmed. `ECHO` is `PRINT` under
an alias; use whichever reads better to you.

### 1.2 COLOR

`COLOR` sets the color used by every following `PRINT` (and later, every
`PUT`), until the next `COLOR`:

```text
COLOR cyan
PRINT "this is cyan"
PRINT "still cyan"
COLOR pink
PRINT "now pink"
```

The palette is `white`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`,
and `pink`. Anything else falls back to white.

### 1.3 WAIT

`WAIT` pauses for a number of **milliseconds** — thousandths of a second, so
`WAIT 1000` is one second:

```text
PRINT "3"
WAIT 1000
PRINT "2"
WAIT 1000
PRINT "1"
WAIT 1000
PRINT "liftoff"
```

`SLEEP` is an alias. While waiting, DOLL-OS keeps servicing the display, the radio,
and FTP — a waiting app doesn't freeze the machine.

### 1.4 CLEAR, comments, and EXIT

```text
# a comment: the interpreter skips this line
// this style works too
CLEAR              wipe the terminal (CLS is an alias)
EXIT               end the program (END is an alias)
```

A program also ends when it runs off its last line, but an explicit `EXIT`
reads better and lets you end from the middle.

### 1.5 Your first real program

```text
# /sd/apps/greet.dapp
CLEAR
COLOR cyan
PRINT "DOLL-OS ONLINE"
WAIT 500
COLOR white
PRINT "all systems nominal"
WAIT 500
COLOR pink
PRINT "have a nice day"
EXIT
```

### Practice 1

1. Write a traffic light: print `STOP` in red, wait two seconds, print `READY`
   in yellow, wait one second, print `GO` in green.
2. Make a program that clears the screen, then prints your name five times,
   each line in a different color.
3. What is the difference between `PRINT "  hi  "` and `PRINT   hi  `? Predict,
   then test.

---

## Chapter 2 — Numbers

### 2.1 Variables

A variable is a named number. `SET` creates it (or overwrites it):

```text
SET score 0
SET lives 3
```

You never declare variables — naming one brings it into existence, starting at
0. Names are made of letters, digits, and `_`, and they are case-sensitive:
`Score` and `score` are two different variables. Stick to lowercase and you
will never be surprised. All values are **whole numbers** (from about
-2.1 billion to +2.1 billion); there are no decimals in variables.

To use a variable's value, put `$` in front of its name:

```text
SET score 100
PRINT "score is $score"
SET backup $score
```

Inside a `PRINT` string, `$name` is replaced by the value. As a command
argument, `$score` means "the value of score." (Writing just `score` as a
value argument usually works too, but the `$` makes intent visible — use it.)

### 2.2 Arithmetic commands

Each of these changes a variable by one value:

```text
SET  hp 100      hp is now 100
ADD  hp 25       hp is now 125
SUB  hp 5        hp is now 120
MUL  hp 2        hp is now 240
DIV  hp 7        hp is now 34   (whole-number division, remainder discarded)
MOD  hp 10       hp is now 4    (the remainder after dividing by 10)
```

`DIV` and `MOD` stop the program with an error if the value is zero — there is
no dividing by zero, here or anywhere.

The value can itself be a variable:

```text
SET bonus 50
ADD score $bonus
```

One command, one operation. That is deliberately spartan; Chapter 6 introduces
`EXPR`, which does whole formulas in one line. Learn these first — for
counters and running totals they are all you need.

### 2.3 RAND

`RAND` puts a random number into a variable. Two forms:

```text
RAND coin 2        0 or 1        (one argument: 0 up to but not including 2)
RAND die 1 6       1 through 6   (two arguments: both ends included)
```

A dice roller:

```text
RAND a 1 6
RAND b 1 6
SET total $a
ADD total $b
PRINT "you rolled $a and $b: $total"
```

### 2.4 Built-in values

Some `$names` are provided by the system:

```text
$millis    milliseconds since the device booted
$seconds   the same, in seconds
$battery   battery percent
$heap      free internal memory in bytes
$wifi      1 if connected, else 0
$ip        the device's IP address (text)
$cwd       the shell's current directory (text)
```

`$millis` is the important one — it is the clock every game runs on, and
Chapter 8 is built around it.

### Practice 2

1. Set `apples` to 7 and `oranges` to 5. Print `12 pieces of fruit` using a
   third variable — without writing the number 12 yourself.
2. Roll three six-sided dice and print the total.
3. Using only `DIV` and `MOD`, split 137 seconds into minutes and seconds and
   print `2m 17s`.
4. Predict what `SET x 7` then `DIV x 2` leaves in `x`. Then predict `MOD x 2`
   applied after that. Test both.

---

## Chapter 3 — Text

### 3.1 String variables

Numbers and text live in **separate kinds of variables**. `SETSTR` sets a
string, `APPEND` adds to its end:

```text
SETSTR name "Asuka"
APPEND name " Langley"
PRINT "pilot: $name"
```

The same `$name` syntax reads either kind — `PRINT` doesn't care whether
`$name` is text or a number. But the arithmetic commands (`ADD`, `SUB`, ...)
work only on numeric variables, and `SETSTR`/`APPEND` only on strings. A name
refers to at most one of the two; don't reuse a name across kinds.

Text in `SETSTR` and `APPEND` expands `$variables`, so strings can be built
from pieces:

```text
SET score 420
SETSTR banner "final score: $score points"
PRINT $banner
```

### 3.2 INPUT

`INPUT` asks the user for a line of text and stores it in a string variable.
The program stops and waits until Enter is pressed:

```text
INPUT name "what is your name? "
PRINT "hello, $name"
```

The second argument is the prompt; leave it off and DOLL-OS shows `name> `.

### 3.3 A warning that will save you an evening

**What `INPUT` gives you is text, and text never automatically becomes a
number.** If the user types `42`, the string variable holds the two characters
`4` and `2` — and using it where a number is expected yields 0, not 42.

You *can* compare strings for equality, with `IFEQ`/`IFNE` (next chapter), so
programs that check exact answers work fine. Programs that need to do *math*
on typed input must convert it themselves — Chapter 5 builds the conversion
routine, and it is shorter than you'd fear.

### 3.4 Taking strings apart

Four commands inspect and build strings:

```text
LEN n <text>              put the length of the text into numeric variable n
CHARAT n <text> <i>       put the character code at position i into n
SUBSTR s <text> <start> <count>   copy a slice into string variable s
CHR s <code>              set string variable s to the single character <code>
```

Positions count from 0. Character codes are ASCII: `A` is 65, `a` is 97, `0`
is 48, space is 32. `CHARAT` past the end of the string gives 0, and `SUBSTR`
quietly clamps a slice that runs off the end — neither is an error.

```text
SETSTR word "tetris"
LEN n $word
PRINT "length: $n"          length: 6
CHARAT c $word 0
PRINT "first code: $c"      first code: 116 (lowercase t)
SUBSTR part $word 0 3
PRINT "slice: $part"        slice: tet
CHR letter 65
PRINT "letter: $letter"     letter: A
```

### Practice 3

1. Ask for the user's name and print it three times on one line, separated by
   spaces, using `SETSTR` and `APPEND`.
2. Ask for a word and print its first and last characters' codes. (You will
   need `LEN` and a `SUB`.)
3. `CHR` only accepts codes 32–126 (printable ASCII); anything else becomes a
   space. Why do you think the language refuses to put control characters in
   strings? (Think about what `PRINT` would do with them.)

---

## Chapter 4 — Jumps and Choices

### 4.1 Labels and GOTO

Programs normally run top to bottom. A **label** marks a line; `GOTO` jumps
to it:

```text
:forever
PRINT "again!"
WAIT 500
GOTO forever
```

`:name` on its own line is a label. (`LABEL name` is the long spelling.)
Labels are jump *targets* — execution passing through one does nothing.

That example never ends by itself — press **Ctrl+X** to abort a running app,
the same chord that exits the editor. DOLL-OS also has a second line of defense: a
loop that runs a million commands without ever `WAIT`ing gets stopped by the
interpreter, on the theory that a loop that never pauses is a bug, not a
program. (A loop *with* a `WAIT` is presumed intentional and runs forever —
that is exactly why Ctrl+X exists. One habit worth forming anyway: give every
loop a way out.)

### 4.2 IF — numeric decisions

```text
IF <left> <op> <right> GOTO <label>
```

If the comparison is true, jump; otherwise continue to the next line. The
operators are `=` `==` (equal), `!=` `<>` (not equal), `<` `<=` `>` `>=`.

```text
SET hp 3
:hit
PRINT "ouch! hp=$hp"
SUB hp 1
WAIT 400
IF $hp > 0 GOTO hit
PRINT "game over"
```

That shape — *do the work, change a counter, jump back while a condition
holds* — is **the loop**, and you will write it hundreds of times. A counted
loop, for the times you know how many:

```text
SET i 0
:loop
PRINT "i is $i"
ADD i 1
IF $i < 5 GOTO loop
```

### 4.3 IFEQ and IFNE — text decisions

`IF` compares numbers. For strings there is `IFEQ` (equal) and `IFNE` (not
equal):

```text
:ask
INPUT reply "password? "
IFNE $reply "swordfish" GOTO wrong
PRINT "welcome."
EXIT

:wrong
PRINT "no."
GOTO ask
```

Quote any string literal containing spaces. `IFEQ`/`IFNE` compare exactly —
case, spaces, everything.

### 4.4 Choosing among many

There is no "else" — you build it from jumps. The idiom for a menu:

```text
INPUT choice "attack, run, or hide? "
IFEQ $choice "attack" GOTO attack
IFEQ $choice "run" GOTO run
IFEQ $choice "hide" GOTO hide
PRINT "unknown command"
GOTO menu
```

Each test either jumps away or falls through to the next — the last line is
what happens when nothing matched. Read a chain like this as a `switch`
statement written long-hand.

### Practice 4

1. Count down from 10 to 1, one line per number, half a second apart, then
   print `LIFTOFF`.
2. Print the multiples of 7 that are less than 100.
3. Write a quiz: ask "what is the capital of france? " and loop until the
   answer is `paris`, counting attempts. Report the count at the end.
4. This program is meant to print `done` after ten trips around the loop.
   Instead it dies with `stopped after 1000000 steps`. Why — and what one
   line fixes it?
   ```text
   SET i 0
   :loop
   IF $i >= 10 GOTO done
   GOTO loop
   :done
   PRINT "done"
   ```

---

## Chapter 5 — Routines

### 5.1 GOSUB and RETURN

`GOSUB` jumps to a label like `GOTO`, but remembers where it came from.
`RETURN` goes back to the line after the `GOSUB`:

```text
GOSUB fanfare
PRINT "back in the main program"
GOSUB fanfare
EXIT

:fanfare
COLOR yellow
PRINT "*** ta-da! ***"
COLOR white
RETURN
```

`fanfare` runs twice, and each time control comes back. A labeled block that
ends in `RETURN` is a **routine** — a named, reusable piece of program. Notice
the `EXIT` before the routine: without it, the main program would fall off its
last line *into* `:fanfare`, and the `RETURN` at the end would have nowhere to
go. Keep routines below an `EXIT` (or below the main loop's `GOTO`).

Routines may call other routines, up to 64 levels deep. The conditional forms
work too: `IF $hp < 1 GOSUB die` calls and comes back.

### 5.2 Passing values in and out

Routines have no private variables — every variable is shared by the whole
program. The convention: set agreed-upon variables before the call, read
agreed-upon variables after, and say so in a comment:

```text
# in: w, h   out: area
:rectarea
SET area $w
MUL area $h
RETURN
```

```text
SET w 6
SET h 4
GOSUB rectarea
PRINT "area: $area"
```

Because everything is shared, a routine that quietly reuses a name like `i`
will trample its caller's `i`. Pick distinct names for routine-internal
counters (`ri`, `ci`, ...) — future you will be grateful.

### 5.3 The one rule: leave through RETURN

A routine may jump around *inside* itself freely. What it must never do is
`GOTO` somewhere *outside* itself instead of returning. Each `GOSUB` stores a
return address; only `RETURN` removes one. Jump out and the address is
stranded — do that in a loop and the stack fills, and the app dies at depth
64 with `GOSUB nested deeper than 64`.

When a routine discovers something the caller must act on — the player died,
the piece can't move — **set a variable and RETURN**:

```text
# out: hit (1 = collision)
:collide
SET hit 0
IF $x < 0 GOTO collide_bad
IF $x > 9 GOTO collide_bad
RETURN
:collide_bad
SET hit 1
RETURN
```

The internal `GOTO collide_bad` is fine — it lands on a line that `RETURN`s.
The caller then decides:

```text
GOSUB collide
IF $hit = 1 GOTO undo_move
```

### 5.4 Worked example: text into numbers

Chapter 3 promised the fix for `INPUT` giving you text. Here it is — a routine
that reads digits off the front of a string and builds the number, using only
tools you already have:

```text
# in: text (string)   out: num
:str2num
SET num 0
SET si 0
LEN slen $text
:s2n_loop
IF $si >= $slen GOTO s2n_done
CHARAT d $text $si
IF $d < 48 GOTO s2n_done
IF $d > 57 GOTO s2n_done
SUB d 48
MUL num 10
ADD num $d
ADD si 1
GOTO s2n_loop
:s2n_done
RETURN
```

Digit characters have codes 48 (`0`) through 57 (`9`), so `SUB d 48` turns a
code into its digit, and `num = num*10 + digit` shifts it in. Now the classic
guessing game is possible:

```text
RAND secret 1 100
PRINT "I'm thinking of a number from 1 to 100."

:guess
INPUT text "guess> "
GOSUB str2num
IF $num < $secret GOTO low
IF $num > $secret GOTO high
COLOR green
PRINT "yes! it was $secret"
EXIT

:low
PRINT "higher..."
GOTO guess
:high
PRINT "lower..."
GOTO guess
```

(Routines from `:str2num` go at the bottom, after the last `EXIT`.)

### Practice 5

1. Write a routine `# in: n  out: fact` that computes n factorial
   (1×2×...×n), and use it to print the factorials of 1 through 8.
2. Write a routine that prints a line of `n` stars (`*`), then use it to draw
   a triangle ten rows tall.
3. Extend the guessing game to count guesses and report the count on success.
4. This routine is correct — test it alone and it works forever. Yet pasted
   into one particular larger program, it crashed after a few hundred calls
   with `GOSUB nested deeper than 64`. The routine has no bug. What property
   of *labels* makes it dangerous anyway, and what do the tetris routines do
   about it?
   ```text
   # in: x   out: sign
   :signof
   SET sign 1
   IF $x >= 0 GOTO done
   SET sign 0
   SUB sign 1
   :done
   RETURN
   ```

---

## Chapter 6 — EXPR

### 6.1 Whole formulas at once

The Chapter 2 commands do one operation each. Real formulas get tedious:

```text
# index = row * 10 + col, the hard way
SET index $row
MUL index 10
ADD index $col
```

`EXPR` evaluates an entire expression and stores the result:

```text
EXPR index $row * 10 + $col
```

Everything after the variable name is the formula. Spaces are fine.
Parentheses group. The operators are `+ - * / ^ %` (`^` is power, `%` is
remainder), plus functions: `abs(x)`, `floor(x)`, `ceil(x)`, `sqrt(x)`,
`pow(x,y)`, and the trig set (`sin`, `cos`, `tan`, ...). It is the same
evaluator behind the shell's `calc` command.

```text
EXPR c sqrt($a*$a + $b*$b)
EXPR wrapped ($angle + 360) % 360
EXPR dropat $millis + $dropms
```

Every `$name` in the formula is replaced by its **numeric** value before
evaluation — string variables have no business in a formula.

### 6.2 The rounding rule (read this twice)

`EXPR` computes with real numbers internally, then **rounds to the nearest
whole number** when storing. `DIV` truncates. These disagree:

```text
SET a 7
DIV a 2          a is 3   (truncated)
EXPR b 7 / 2     b is 4   (3.5 rounded up)
```

When a formula needs throw-away-the-remainder division — and grid math almost
always does — wrap it in `floor()`:

```text
EXPR level floor($lines / 10) + 1
EXPR row floor($i / 10)
EXPR col $i % 10
```

That `floor(i/10)` / `i%10` pair converts a flat index into row and column.
Memorize it; Chapter 7 is built on it.

### Practice 6

1. Redo Practice 2.3 (137 seconds into minutes and seconds) as two `EXPR`
   lines.
2. Convert a Celsius temperature to Fahrenheit: F = C × 9 / 5 + 32. Check
   what your program says for 37, and think about whether rounding or
   truncation is what you want here.
3. Without running it: what does `EXPR x 5 / 10` store in `x`? What about
   `EXPR x floor(5 / 10)`? Now run both.
4. A circle's area is πr². There is no `$pi` built-in — get π from
   `EXPR pi 4 * atan(1)` and compute the area for r = 10.

---

## Chapter 7 — Arrays

### 7.1 Two hundred variables would be terrible

A game board is hundreds of cells. Naming them `cell0`, `cell1`, ... `cell199`
is obviously unworkable — and the 64-variable limit stops you long before 200
anyway. An **array** is one name for many numbered cells:

```text
DIM scores 10
```

That creates `scores`, ten cells, numbered 0 through 9, each starting at 0.
Read a cell with `$name[index]`, write one by using `name[index]` where a
variable name would go:

```text
SET scores[0] 100
SET scores[1] 250
EXPR scores[2] $scores[0] + $scores[1]
PRINT "third: $scores[2]"
```

The index is itself a value — a number, a `$variable`, or arithmetic hiding
inside a subscript:

```text
SET i 5
SET scores[$i] 999
PRINT "$scores[$i]"
```

Arrays hold numbers only (there are no string arrays), up to 16 arrays per
program, sharing a pool of 8192 cells.

### 7.2 The bounds check is your friend

Reading or writing outside an array — `$scores[10]` on a ten-cell array, or a
negative index — **stops the program immediately** and reports the line
number. This is a feature. The alternative (silently reading 0) turns a
one-character bug into an evening of "why is my board empty in one corner."
When your app dies with `index 10 outside scores[0..9] (line 40)`, it is
telling you exactly where you got your index math wrong. Thank it and go look
at line 40.

### 7.3 A grid in a straight line

Arrays are one-dimensional; boards are two-dimensional. The bridge is the
formula from Chapter 6. For a grid `W` cells wide, cell (row, col) lives at:

```text
index = row * W + col
```

and back the other way: `row = floor(index / W)`, `col = index % W`. A 10-wide,
20-tall playfield:

```text
DIM board 200

# write: board[row=3][col=7] = 5
EXPR i 3 * 10 + 7
SET board[$i] 5

# read every cell, row by row
SET r 0
:rows
SET c 0
:cols
EXPR i $r * 10 + $c
IF $board[$i] <> 0 GOSUB drawcell
ADD c 1
IF $c < 10 GOTO cols
ADD r 1
IF $r < 20 GOTO rows
```

That nested pair of counted loops is *the* array-walking pattern. Notice each
loop resets its counter at the top — forget `SET c 0` inside the outer loop
and only the first row gets visited.

### 7.4 Re-DIM to reset

`DIM` on a name that already exists, at the same size, zeroes every cell —
that is the "new game" button. (At a *different* size it is an error; an
array's size is for life.)

### Practice 7

1. `DIM rolls 6`, roll a die 100 times, count how many times each face came
   up, and print the six counts. (The array index *is* the tally slot.)
2. Fill a 20-cell array with the squares 1, 4, 9, ... 400, then print them
   back in reverse order.
3. Using a 10×10 grid in a 100-cell array, set the two diagonals to 1 and
   count how many cells got set. (Careful: the diagonals cross. What does
   your count say, and why?)
4. Predict the error message: `DIM a 5` then `SET i 5` then `PRINT "$a[$i]"`.

---

## Chapter 8 — The Game Loop

### 8.1 Why INPUT can't run a game

`INPUT` stops the world until Enter. Games can't stop the world — gravity
pulls the piece down whether or not you are touching the keys. What a game
needs is *"did the player press something? if yes, what? either way, keep
moving"* — and that is `KEY`:

```text
KEY k
```

`KEY` never waits. It reads **at most one** keypress into a numeric variable:
0 if nothing was pressed, otherwise a code saying what. It hears both the
telnet client and a BLE keyboard on the companion DOLL-OS keyboard bridge.

### 8.2 Key codes

Letters, digits, and punctuation come back as their ASCII code — `a` is 97,
space is 32. The special keys have named built-ins so you never memorize
their numbers:

```text
$kup  $kdown  $kleft  $kright     arrow keys
$kenter  $kesc  $kback  $ktab     enter, escape, backspace, tab
$kspace                           the space bar (same as 32)
```

These are numbers, for comparing — `PRINT "$kup"` prints nothing useful.
Ctrl+C and Ctrl+T also arrive as `$kesc`, so the quit-chord users already
know from the rest of DOLL-OS works in your game for free. Ctrl+X never reaches
your program at all — it aborts the app on the spot, which is what makes an
infinite `KEY` loop safe to experiment with.

```text
:loop
KEY k
IF $k = 0 GOTO loop_wait
IF $k = $kleft GOSUB move_left
IF $k = $kright GOSUB move_right
IF $k = $kesc GOTO quit
IF $k = 112 GOSUB toggle_pause     the letter p
:loop_wait
WAIT 16
GOTO loop
```

### 8.3 The WAIT matters

That `WAIT 16` is not decoration. It paces the loop to roughly sixty trips a
second — fast enough that input feels instant, slow enough that the display
and radio get serviced. It also resets the runaway-loop guard: the
interpreter's rule is that a loop that `WAIT`s is a program and a loop that
never does is a bug. A game loop with a `WAIT` in it can run all day.

### 8.4 Doing things on time

The wrong way to make something happen every 650 ms is to `WAIT 650` — then
the player can't move during the wait. The right way: remember *when the next
one is due*, and check the clock each trip around the loop:

```text
EXPR dropat $millis + 650

:loop
KEY k
# ... handle keys every single trip ...
IF $millis < $dropat GOTO loop_wait
GOSUB gravity
EXPR dropat $millis + 650
:loop_wait
WAIT 16
GOTO loop
```

Input is checked ~60 times a second; gravity fires when its moment comes.
Every timed thing in a game — falling pieces, blinking text, a speed-up per
level — is this pattern with a different variable.

### 8.5 The dirty flag

Redrawing the screen is the slowest thing a game does, and most loop trips
nothing has visibly changed. So: keep a variable `dirty`, set it to 1 whenever
you change something visible, and redraw only when it is set:

```text
:loop
IF $dirty = 1 GOSUB draw
SET dirty 0
...
```

Every routine that moves a piece or bumps the score does `SET dirty 1` and
nothing more; the loop redraws once, however many things changed.

### Practice 8

1. Write a stopwatch: `s` starts it and prints elapsed seconds when pressed
   again; `$kesc` quits. (You will want `$seconds` and a saved start time.)
2. Make a counter that shows a number which climbs by 1 every second, while
   `$kup` and `$kdown` add and subtract 10 instantly. (Two timescales — one
   from the clock pattern, one from keys.)
3. What goes wrong with the 8.4 loop if you write `EXPR dropat $dropat + 650`
   instead of `$millis + 650`? When would you *want* that version? (This is a
   real design choice — think about what happens after a lag spike.)

---

## Chapter 9 — The Canvas

### 9.1 A screen you can draw on

`PRINT` appends lines to a scrolling terminal, which is exactly wrong for a
game: you can't put the score *back at the top* or redraw the playfield in
place. `CANVAS` replaces the scroll with a fixed grid of character cells that
you address directly:

```text
CANVAS 32 22        a grid 32 columns wide, 22 rows tall
PUT 13 10 "hello"   write text at column 13, row 10
FLIP                show it
WAIT 1000
ENDCANVAS           put the normal terminal back
```

Coordinates are column-first, counted from 0, origin at the top-left. `PUT`
draws in the current `COLOR`. Text that runs off an edge is clipped, not an
error — drawing a sprite half off-screen is normal and fine.

On the panel the grid is scaled up to fill the screen — a small grid gets big
chunky cells, a big grid gets fine ones. On telnet the same frame is drawn in
place, without scrolling. Maximum size is 120×60.

### 9.2 PUT draws nothing; FLIP shows everything

`PUT` writes into an off-screen buffer. Nothing appears until `FLIP` pushes
the whole buffer at once. This is what makes animation clean: build the entire
frame — erase, borders, board, piece, score — then one `FLIP`. The screen
goes straight from the old complete frame to the new complete frame, and
never shows a half-drawn one.

The frame loop is always the same shape:

```text
:draw
CLS                        blank the canvas (CLS clears the *grid* while one is up)
PUT ... everything ...
FLIP
RETURN
```

Two rules while a canvas is up: **don't `PRINT`** (it goes to the terminal
underneath and garbles the telnet view — save your goodbye message for after
`ENDCANVAS`), and don't forget `ENDCANVAS` on the way out (though DOLL-OS restores
the terminal automatically when the app ends, even if it crashed).

### 9.3 Worked example: the bouncing ball

The complete canvas-plus-game-loop pattern in thirty lines:

```text
CANVAS 40 20
SET x 5
SET y 3
SET dx 1
SET dy 1

:loop
KEY k
IF $k = $kesc GOTO done

ADD x $dx
ADD y $dy
IF $x > 0 GOTO checkright
SET dx 1
:checkright
IF $x < 39 GOTO checktop
SET dx 0
SUB dx 1
:checktop
IF $y > 0 GOTO checkbottom
SET dy 1
:checkbottom
IF $y < 19 GOTO draw
SET dy 0
SUB dy 1

:draw
CLS
COLOR cyan
PUT $x $y "o"
FLIP
WAIT 50
GOTO loop

:done
ENDCANVAS
PRINT "bounced out"
EXIT
```

Move, bounce off each wall by flipping the direction's sign, erase, draw,
flip, wait, repeat. Every 2-D game you write is this program with more
variables. (`SET dx 0` / `SUB dx 1` is "set dx to -1" — remember `SET`'s
argument is a value, and `-1` is a fine value: `SET dx -1` works too. The long
spelling above is just to show sign-flipping without negative literals.)

### Practice 9

1. Draw a checkerboard: an 8×8 grid where cells with (row+col) even get `##`.
   (You'll want `MOD` or `%`.)
2. Make the ball leave a trail: *don't* `CLS` each frame. Then explain why
   the no-trail version needs the `CLS`.
3. Two balls, different speeds. (Hint: the second ball moves every *other*
   frame — a counter and a `MOD` will do it.)
4. Put a live clock in the corner of the bouncing-ball screen: `$seconds`
   since boot, updated only when it changes. (Dirty-flag thinking: what marks
   it stale?)

---

## Chapter 10 — Project: Tetris

Time to spend everything. The finished game ships on the device — `run
tetris`, and the source is `/apps/tetris.dapp` (about 400 lines, half of it
data). This chapter builds it in the order it was actually built. Type each
stage in, run it, watch it work, then build the next on top.

We will need: an array for the well, arrays for piece shapes, `EXPR` for the
index math, `KEY` + `$millis` for the loop, the canvas for drawing, and
routines for everything — every chapter of this book, load-bearing at once.

### 10.1 The plan

Tetris is smaller than its reputation. The whole game is:

- a **well**, 10 columns × 20 rows — an array where 0 is empty and 1–7 says
  which color of block has settled there;
- a **current piece** — which of the 7 shapes (`piece`), where it is (`px`,
  `py`), and how it's turned (`rot`);
- **gravity** — the piece's `py` increases on a timer;
- **collision** — "would the piece overlap a wall or a settled block?";
- **locking** — a piece that can't fall stamps itself into the well, full
  rows vanish, a new piece spawns;
- a **draw** routine that paints all of it.

Everything else is decoration. Take these one at a time.

### 10.2 The screen

A 10-wide well drawn 2 characters per cell (blocks are `[]` — the classic
look, and twice as wide reads much better than single characters) needs 22
columns with borders; 20 rows plus borders is 22. Add a sidebar for score:

```text
CANVAS 32 22
COLOR blue
PUT 0 0 "+--------------------+"
PUT 0 21 "+--------------------+"
SET dy 1
:draw_side
PUT 0 $dy "|"
PUT 21 $dy "|"
ADD dy 1
IF $dy < 21 GOTO draw_side
FLIP
WAIT 2000
ENDCANVAS
EXIT
```

Run it: an empty well. The mapping from well coordinates to screen
coordinates, used everywhere below: a cell at well column `bx`, row `by`
draws at screen `(bx*2 + 1, by + 1)` — double for the two-character blocks,
plus one for the border.

### 10.3 The well

```text
DIM well 200
```

Cell (row, col) is `well[row*10 + col]`, per Chapter 7. Zero means empty;
1–7 means a settled block wearing that piece's color. That's the entire data
model of the playfield. When we later test "is this spot free," it is one
line: `IF $well[$wi] <> 0 GOTO occupied`.

### 10.4 Describing the pieces

Here is the trick that keeps the data small. Each of the 7 tetrominoes is
four blocks in a small square box (the I piece in a 4×4 box, the O in 2×2,
the rest in 3×3). We store only the **spawn orientation** — for each piece,
the row and column of its four cells — and *compute* the other three
rotations. Three parallel arrays:

```text
DIM pbox 7      box size per piece  (I=4, O=2, others=3)
DIM pr 28       row of cell j of piece p, at index p*4 + j
DIM pc 28       column, same indexing
```

then 63 `SET` lines of pure data (see the shipped file for the full table —
type it once, carefully). For example the T piece (piece 2, box 3) is cells
(0,1), (1,0), (1,1), (1,2):

```text
.#.       pr[8..11]  = 0 1 1 1
###       pc[8..11]  = 1 0 1 2
...
```

The `p*4 + j` indexing is the grid formula again — the 7×4 table of cells,
flattened, exactly like the well.

### 10.5 Rotation is a formula, not a table

Rotating a point clockwise inside an N×N box:

```text
(row, col)  →  (col, N-1-row)
```

Check it on paper with a 3×3 box: (0,0) — top-left — goes to (0,2) —
top-right. Yes: that's a clockwise quarter-turn. Apply the formula `rot`
times and you have any orientation from the spawn data:

```text
# in: piece, rot, i (0..3)   out: cr, cc (cell's row/col in the box)
:cellat
EXPR pi $piece * 4 + $i
SET cr $pr[$pi]
SET cc $pc[$pi]
SET rleft $rot
:cellat_spin
IF $rleft <= 0 GOTO cellat_done
SET t $cr
SET cr $cc
EXPR cc $pbox[$piece] - 1 - $t
SUB rleft 1
GOTO cellat_spin
:cellat_done
RETURN
```

Note the `SET t $cr` — the two assignments each use the *old* values, so the
first one must be stashed before it's overwritten. (A classic bug: swap two
variables without a temporary and watch one value vanish.)

Every routine below asks "where is cell i of the current piece?" by calling
this. The alternative — a hand-typed 7-pieces × 4-rotations table — is 112
rows of data to get wrong. Ten lines of formula beat it.

### 10.6 Collision — move, test, undo

The single most useful routine in the game. "If the piece were at (`px`,
`py`) rotated `rot`, would it fit?" — check all four cells:

```text
# in: px, py, rot, piece   out: hit (1 = doesn't fit)
:collide
SET hit 0
SET i 0
:collide_cell
GOSUB cellat
EXPR bx $px + $cc
EXPR by $py + $cr
IF $bx < 0 GOTO collide_hit
IF $bx > 9 GOTO collide_hit
IF $by > 19 GOTO collide_hit
IF $by < 0 GOTO collide_next
EXPR wi $by * 10 + $bx
IF $well[$wi] <> 0 GOTO collide_hit
:collide_next
ADD i 1
IF $i < 4 GOTO collide_cell
RETURN
:collide_hit
SET hit 1
RETURN
```

Each cell must be inside the side walls and floor, and its well cell must be
empty. One deliberate asymmetry: `by < 0` — above the top — is *legal*, and
skips the well test rather than failing. Pieces spawn with part of their box
above the visible well; forbidding that would end the game one move early.

With `collide` in hand, all movement is the same three-step idiom:

```text
:hk_left
SUB px 1          move
GOSUB collide     test
IF $hit = 0 GOTO hk_left_ok
ADD px 1          undo
:hk_left_ok
SET dirty 1
RETURN
```

Try the move for real, ask if it fits, put it back if not. No "would it fit"
math separate from the "do it" math — the move *is* the test. Rotation, soft
drop, gravity: all this shape.

### 10.7 Drawing a frame

Chapter 9's frame pattern, applied. Blank, borders, then every settled block,
then the falling piece, then the sidebar; one `FLIP` at the end:

```text
:draw
CLS
COLOR blue
# ... the border drawing from 10.2 ...

SET dy 0
:draw_row
SET dx 0
:draw_col
EXPR wi $dy * 10 + $dx
SET ck $well[$wi]
IF $ck = 0 GOTO draw_col_next
GOSUB setcolor
EXPR sx $dx * 2 + 1
EXPR sy $dy + 1
PUT $sx $sy "[]"
:draw_col_next
ADD dx 1
IF $dx < 10 GOTO draw_col
ADD dy 1
IF $dy < 20 GOTO draw_row

EXPR ck $piece + 1
GOSUB setcolor
SET i 0
:draw_piece
GOSUB cellat
EXPR bx $px + $cc
EXPR by $py + $cr
IF $by < 0 GOTO draw_piece_next
EXPR sx $bx * 2 + 1
EXPR sy $by + 1
PUT $sx $sy "[]"
:draw_piece_next
ADD i 1
IF $i < 4 GOTO draw_piece

COLOR cyan
PUT 23 3 "SCORE"
COLOR white
PUT 23 4 $score
FLIP
RETURN
```

`setcolor` is a routine that turns a block's number 1–7 into a `COLOR` — a
Chapter 4 if-chain, one comparison per color (`COLOR` takes a name, not a
number, so dispatching is the only way; it's in the shipped file). Note the
piece skips cells with `by < 0` — the piece can *be* above the well, but
there is nothing up there to draw on.

### 10.8 The heart: the main loop

Chapter 8, verbatim — dirty flag, key poll, clock check:

```text
SET score 0
SET lines 0
SET level 1
SET dropms 650
SET quit 0
SET dirty 1
GOTO spawn

:loop
IF $dirty = 1 GOSUB draw
SET dirty 0
KEY k
IF $k <> 0 GOSUB handlekey
IF $quit = 1 GOTO leave
EXPR remain $dropat - $millis
IF $remain > 0 GOTO loop_wait
GOSUB gravity
IF $locked = 1 GOTO spawn
:loop_wait
WAIT 12
GOTO loop
```

Gravity is move-test-undo pointing down, and when down fails, the piece has
landed:

```text
# out: locked (1 = piece settled and was stamped in)
:gravity
SET locked 0
ADD py 1
GOSUB collide
IF $hit = 0 GOTO gr_done
SUB py 1
GOSUB lock
GOSUB clearlines
GOSUB addscore
SET locked 1
:gr_done
EXPR dropat $millis + $dropms
SET dirty 1
RETURN
```

Notice what `gravity` does *not* do: it doesn't jump to `spawn` itself — it
sets `locked` and returns, and the main loop reads it. That is the Chapter 5
rule paying rent. The first draft of this routine ended with
`GOTO spawn`, and the game died at depth 64 after about sixty pieces —
sixty stranded return addresses. If you hit `GOSUB nested deeper than 64` in
your own games, hunt for exactly this: a routine that jumps out instead of
reporting back.

### 10.9 Steering

`handlekey` is a Chapter 4 dispatch chain — each key either jumps to its
little handler (which `RETURN`s) or falls through to the next test. Both
arrows and WASD, so it plays the same over telnet and a BLE keyboard:

```text
# in: k   out: quit, and moves the piece
:handlekey
IF $k = $kesc GOTO hk_quit
IF $k = $kleft GOTO hk_left
IF $k = 97 GOTO hk_left        a
IF $k = $kright GOTO hk_right
IF $k = 100 GOTO hk_right      d
IF $k = $kup GOTO hk_rot
IF $k = 119 GOTO hk_rot        w
IF $k = $kdown GOTO hk_down
IF $k = 115 GOTO hk_down       s
IF $k = $kspace GOTO hk_drop
RETURN
```

Left and right you have (10.6). Rotation is move-test-undo where the "move"
is `rot`, with one refinement — if the turned piece doesn't fit, try nudging
it one cell right, then one left, before giving up. Those *wall kicks* are
what makes rotating against a wall feel right instead of stubborn:

```text
:hk_rot
SET oldrot $rot
SET oldpx $px
ADD rot 1
IF $rot < 4 GOTO hk_rot_test
SET rot 0
:hk_rot_test
GOSUB collide
IF $hit = 0 GOTO hk_rot_ok
ADD px 1
GOSUB collide
IF $hit = 0 GOTO hk_rot_ok
SUB px 2
GOSUB collide
IF $hit = 0 GOTO hk_rot_ok
SET px $oldpx
SET rot $oldrot
:hk_rot_ok
SET dirty 1
RETURN
```

Soft drop (`hk_down`) is one gravity-step that also resets the drop timer
and scores a point. Hard drop repeats "down until it hits," then sets
`dropat` to 0 — forcing gravity to fire on the very next loop trip, so the
locking happens in the one routine that ever locks. Both are in the shipped
file; write them yourself first, they are each five lines of ideas you have.

### 10.10 Locking and clearing lines

`lock` stamps the four cells into the well — `cellat`, the index formula,
and `SET well[$wi] $lc` where `lc` is `piece + 1` (so color 0 stays
"empty"). Cells above the top (`by < 0`) are skipped.

`clearlines` is the most intricate routine in the game, and it is only three
nested ideas:

```text
for each row from the bottom up:          (ry 19 → 0)
    is every one of its 10 cells non-zero?
    if yes: copy every row above it down one, zero the top row,
            count the clear — and re-check this same ry
```

That "re-check the same row" is the subtle part: after rows shift down, the
row you just cleared holds what was above it — which might *also* be full.
The shipped routine does it by looping on `ry` only when the row was *not*
full. Scoring (`addscore`) then pays 100/300/500/800 × level for 1/2/3/4
lines — the jackpot for a four-line Tetris is the whole point of saving up —
and speeds gravity as levels rise:

```text
EXPR level floor($lines / 10) + 1
EXPR dropms 650 - ($level - 1) * 55
IF $dropms > 80 GOTO as_done
SET dropms 80
:as_done
```

Chapter 6's warning made real: this formula originally read
`$lines / 10 + 1`, and at 5 lines EXPR rounded 0.5 *up* — promoting the
player to level 2 at half the score. `floor()` fixed it. When a threshold in
your game fires early, check your division.

### 10.11 Spawning, dying, leaving

```text
:spawn
RAND piece 7
SET rot 0
SET px 3
SET py 0
GOSUB collide
IF $hit = 1 GOTO gameover
EXPR dropat $millis + $dropms
SET dirty 1
GOTO loop
```

A new piece that collides *immediately* means the stack has reached the
spawn point — and that test, one reused routine, is the entire game-over
detection. `gameover` PUTs a banner over the frozen board, FLIPs, waits, and
falls into `leave`, which does `ENDCANVAS` and prints the final score — with
`PRINT`, legal again now that the canvas is down.

### 10.12 What you built, and what to build next

Count the chapters in the finished file: the well and piece tables (7), every
formula (6), move-test-undo and the frame loop (8, 9), fifteen routines with
one honest contract each (5), and dispatch chains everywhere (4). No single
piece is clever. The game is the *arrangement*.

Extensions, in rough order of difficulty — the honest way to own this code:

1. **Pause key.** One flag, one `IF` in the loop, one banner.
2. **Next-piece preview.** `RAND` one piece ahead; draw it in the sidebar
   (a second, smaller version of the draw-piece loop).
3. **Ghost piece.** Where would the piece land? You have `collide` — drop a
   copy of `py` until it hits, draw the outline there. (Save and restore
   `py` around it. Which variables does `cellat` touch? That contract
   discipline suddenly matters.)
4. **Hold slot.** Swap the current piece into storage, once per drop.
5. **A high score that survives the power switch.** That one needs a whole
   new power — files — and it is exactly what Chapter 12 builds.
6. **Two-player.** There is a second set of... no. Some things need a bigger
   language. Everything above fits in this one.

---

## Chapter 11 — Project: Talk to an LLM

Tetris was a closed world: every fact it needed was already in its arrays.
This project crosses the network. It sends one user message to an
OpenAI-compatible `/v1/chat/completions` endpoint, receives JSON, extracts the
assistant's text, and loops for another prompt.

The finished source ships as `/apps/llm-chat.dapp`. It needs AppRunner 1.4, so
it runs on FNK0104 firmware; Cardputer 1.3 does not have these HTTP and JSON
commands yet.

### 11.1 Choose where the endpoint lives

For a device on your LAN, edit the first two lines to match the server and a
model that server exposes:

```text
SETSTR endpoint "http://192.168.1.50:8000/v1/chat/completions"
SETSTR model "local-model"
```

Do not use `127.0.0.1` unless the LLM server is running on the DOLL itself — on
the device, "localhost" means the ESP32. Use the computer's LAN address.

The browser runner may instead use a same-origin path:

```text
SETSTR endpoint "/v1/chat/completions"
```

That requires the site hosting the runner to proxy that path to the LLM. Browser
CORS rules still apply, and a production API key must live on the server, not
in downloadable JavaScript or a published `.dapp`.

### 11.2 A secret input is different

Some compatible servers require a bearer token. Read it with `INPUTSECRET`,
which is masked on the device and uses a password field in the browser:

```text
INPUTSECRET apikey "Bearer token (blank if none)> "
HTTPCLEAR
HTTPHEADER "Content-Type" "application/json"
IFEQ $apikey "" GOTO headers_ready
HTTPHEADER "Authorization" "Bearer $apikey"
:headers_ready
```

`INPUTSECRET` keeps the submitted value out of terminal output, but the token
still exists in RAM for this run. Do not write it to a file; clear it on exit.

Generic HTTPS encrypts traffic but does not authenticate arbitrary server
certificates. Do not send a valuable production token directly through that
device path. Use a trusted LAN gateway or authenticated server-side proxy.

### 11.3 Build JSON without lying to it

User text may contain quotes, backslashes, or control characters, so inserting
raw `$prompt` would eventually create invalid JSON. Escape it first:

```text
INPUT prompt "you> "
IFEQ $prompt "/quit" GOTO done
JSONESC safe $prompt
IF $jsonok = 0 GOTO prompt_too_long
```

`.dapp` literals do not interpret a backslash-quote. Make a real quote with
`CHR`, then assemble the payload in pieces:

```text
CHR q 34
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
APPEND body "}],"
APPEND body $q
APPEND body "max_completion_tokens$q:256}"
```

`$q` supplies every JSON quote; `$safe` is the only part from the user. The
4096-character limit applies to request and response, so this is a small client.

### 11.4 POST, then inspect facts

```text
PRINT "thinking..."
HTTPPOST raw $endpoint $body 4096
IF $httpok = 0 GOTO http_error
```

A timeout, DNS failure, CORS rejection, or non-2xx status leaves facts instead
of crashing the app:

```text
$httpok          1 only for a successfully read 2xx response
$httpcode        HTTP status, or a negative transport error
$httplen         response bytes retained
$httptruncated   1 when the response exceeded the maximum
```

The network failing is an event to handle. Missing `HTTPPOST` arguments are a
program bug and stop the app.

### 11.5 Pull the answer out of JSON

The first choice's message contains the assistant text:

```text
JSONGET answer $raw "choices[0].message.content"
IF $jsonok = 0 GOTO json_error
COLOR cyan
PRINT "llm> $answer"
COLOR white
GOTO chat
```

`JSONGET` understands dotted object keys and bracketed array indexes. Missing
paths and malformed JSON leave `$jsonok` at 0 rather than stopping the program.

### 11.6 Finish every exit path

```text
:http_error
COLOR red
PRINT "request failed: HTTP $httpcode"
PRINT "$raw"
COLOR white
GOTO chat

:json_error
COLOR red
PRINT "response did not contain choices[0].message.content"
PRINT "$raw"
COLOR white
GOTO chat

:done
HTTPCLEAR
SETSTR apikey ""
PRINT "bye"
END
```

Run the shipped version with `run llm-chat`. Each request is intentionally
single-turn. Conversation memory is the next design problem: append earlier
messages while watching the 4096-character ceiling.

### Practice 11

1. Add a system message before the user message; `JSONESC` its text.
2. Warn when `$httptruncated` is 1.
3. Include the previous assistant reply in the next request.
4. Add `/model` to change the model string without sending a request.

---

## Chapter 12 — Files

Everything so far vanishes when the app ends. Every variable, every array,
the high score you just fought for — gone. Files are how a program leaves a
note for its future self, and they are the last commands in the language.

### 12.1 One file at a time

```text
FOPEN <path> <mode>    open: read, write, append, or update
FCLOSE                 close it
```

One file can be open at a time. `FOPEN` while another file is open closes the
old one first, and the app ending closes whatever was left — so a forgotten
`FCLOSE` is untidy, never fatal. Paths are shell paths: `/sd/...` is the card,
everything else is flash, and `$variables` expand inside them (so
`FOPEN "/apps/save_$slot.txt" read` works).

The four modes:

```text
read     the file must exist; you will FREAD from it
write    start the file over from nothing; you will FWRITE to it
append   like write, but existing content is kept and you add to the end
update   read and write in place without truncating the existing file
```

Whether the open *worked* is in the built-in `$fok` — 1 or 0:

```text
FOPEN "/apps/save.txt" read
IF $fok = 0 GOTO nosave
```

Notice the philosophy split, because it is the same one the array bounds check
taught: a **missing file is a fact**, not a bug — save files legitimately
don't exist yet, so `FOPEN` reports through `$fok` and lets the script decide.
But **misusing the handle is a bug** — `FREAD` with nothing open, or against a
file opened for `write` — and stops the app with an error like any other.

### 12.2 Writing

`FWRITE` writes one line, `$variables` expanded, newline supplied:

```text
# /sd/apps/log.dapp -- a captain's log, one entry per run
FOPEN "/apps/log.txt" append
IF $fok = 0 GOTO fail
FWRITE "up $seconds seconds, battery $battery%"
FCLOSE
PRINT "logged."
EXIT

:fail
PRINT "couldn't open the log"
EXIT
```

Run it a few times, then `cat /apps/log.txt` from the shell — one line per
run. `append` is what made that accumulate; `write` would have started over
each time, leaving only the newest entry. Choosing between them *is* the
design decision most file code comes down to: a log appends, a save file
overwrites.

### 12.3 Reading

`FREAD` reads one line into a string variable. The built-in `$feof` ("end of
file") becomes 1 when a read finds nothing left — and that, not the empty
string, is how you detect the end, because an empty *line* in the middle of a
file is real data that leaves `$feof` at 0:

```text
FOPEN "/apps/log.txt" read
IF $fok = 0 GOTO nolog
SET n 0
:rl
FREAD line
IF $feof = 1 GOTO done
ADD n 1
PRINT "$n: $line"
GOTO rl
:done
FCLOSE
PRINT "$n entries"
EXIT
:nolog
PRINT "no log yet"
EXIT
```

That `:rl` loop is the file-reading pattern, and it is worth reading twice:
*read first, test `$feof`, then use the line*. Testing after using processes a
phantom empty line at the end; reading after testing skips the first line.
Read, test, use.

### 12.4 FEXISTS and FDELETE

```text
FEXISTS <numvar> <path>     1 if the path exists, else 0
FDELETE <path>              delete a file; $fok says whether it worked
```

`FEXISTS` answers "is there a save?" without disturbing the open handle, which
makes it the polite first move before an `FOPEN read`. `FDELETE` is the reset
button — a "clear high score" menu option is one line. Deleting a file that
isn't there just leaves `$fok` at 0; nothing stops.

### 12.5 Binary files and honest hex

`FREAD` is a line reader, so it cannot represent every byte. A NUL byte and a
newline are data in a binary file, not string punctuation. Use numeric byte I/O:

```text
FOPEN "/apps/data.bin" update
FSIZE size
FSEEK 0
FREADB byte
IF $feof = 1 GOTO done
HEX shown $byte 2
PRINT "$shown"
FSEEK 0
FWRITEB 255
:done
FCLOSE
```

`FREADB` returns 0..255; `$feof` distinguishes a real zero byte from end of
file. `FSEEK`, `FTELL`, and `FSIZE` use absolute byte positions, and `update`
writes without erasing the file first. The shipped `run hex` app builds its
viewer/editor from exactly these commands.

### 12.6 Numbers come back as text

Here is the trap the chapter has been building toward. You `FWRITE $score`
and the file now holds `3300` — as **four characters**. When `FREAD` brings
it back, you hold a string, and Chapter 3's warning applies in full: using it
as a number yields 0, silently.

The cure is the routine you already own: Chapter 5.4's `str2num`, digits off
the front of a string. Write number → text is free (`FWRITE` expands `$score`
for you); text → number is `str2num`. Every save-file scheme in this language
is those two moves.

### 12.7 Tetris remembers

Now the real thing — the code that makes `run tetris` greet you with your
best score. Two additions to the shipped game, both short. Loading, called
once at startup (`GOSUB loadhs`):

```text
# reads /apps/tetris.hs into hiscore, tolerating a missing or garbled file
:loadhs
SET hiscore 0
FEXISTS hs "/apps/tetris.hs"
IF $hs = 0 GOTO lh_done
FOPEN "/apps/tetris.hs" read
IF $fok = 0 GOTO lh_done
FREAD text
FCLOSE
GOSUB str2num
SET hiscore $num
:lh_done
RETURN
```

Count the ways this refuses to die: no file → `hiscore` stays 0; unopenable
file → 0; a garbled file (`str2num` stops at the first non-digit) → 0. A save
loader must treat the file as *untrusted* — the one thing it may never do is
crash the game over a bad byte on flash. And saving, in `gameover`:

```text
:gameover
IF $score <= $hiscore GOTO go_banner
SET hiscore $score
FOPEN "/apps/tetris.hs" write
IF $fok = 0 GOTO go_nosave
FWRITE $score
FCLOSE
:go_nosave
COLOR yellow
PUT 4 8 "NEW HIGH SCORE"
:go_banner
...
```

`write`, not `append` — a save file's whole job is to hold the latest truth.
Note the shipped `str2num` wears prefixed names (`s2i`, `s2len`, `s2d`)
instead of Chapter 5.4's bare ones: inside a program that already uses `i`
and `d` everywhere, Practice 5.4's label-and-name lesson stopped being
theoretical. One more detail worth stealing: the banner shows even when the
*saving* failed (`go_nosave`) — the player still earned it; only the
bookkeeping fell short.

### Practice 12

1. Extend the captain's log with a run counter: the first line of
   `/apps/log.txt` holds how many times the app has run, and each run
   rewrites the file with the incremented count plus a fresh entry line.
   (Read-modify-write — you will need `str2num`.)
2. Point the 12.3 reader at any file and report the number of lines and the
   length of the longest one.
3. Give the Chapter 9 bouncing ball a settings file: if `/apps/ball.cfg`
   exists, its first line is the `WAIT` delay; otherwise use 50.
4. `FWRITE "hello"` immediately followed by `FREAD line` stops the app. Why —
   and what is the correct sequence to write a file and then read it back?

---

## Appendix A — Command Reference

```text
── output ──────────────────────────────────────────────────────────
PRINT <text>           print a line, $variables expanded  (alias ECHO)
COLOR <name>           white red green yellow blue magenta cyan pink
CLEAR                  clear terminal, or canvas if one is up  (alias CLS)

── numbers ─────────────────────────────────────────────────────────
SET <name> <value>     assign            ADD/SUB/MUL/DIV/MOD likewise
EXPR <name> <formula>  full expression; rounds to nearest — floor() to chop
RAND <n> <max>         0..max-1
RAND <n> <min> <max>   min..max inclusive
DIM <name> <size>      make an array; $name[i] reads, name[i] writes

── strings ─────────────────────────────────────────────────────────
SETSTR <name> <text>   assign            APPEND <name> <text>  concatenate
CHR <name> <code>      one character from its code (32..126)
HEX <name> <value> [w] uppercase hexadecimal text, width 1..8
SUBSTR <n> <t> <s> <c> slice: from position s, c characters
LEN <n> <text>         length → numeric variable
CHARAT <n> <t> <i>     character code at i, 0 past the end

── input ───────────────────────────────────────────────────────────
INPUT <name> [prompt]  read a line (blocks); result is TEXT, not a number
INPUTSECRET <n> [p]    read a masked line; clear secrets when finished
KEY <name>             one keypress or 0, never blocks
LED <r> <g> <b>        set rear RGB LED channels (needs runtime >=1.3.0)
WAVE <ch> <kind> <hz> <level>  three-channel PCM synth (runtime >=1.4.0)
WAVESTOP               silence and release the synth
HTTPGET <n> <url> [max] bounded text GET; inspect $httpok/$httpcode
HTTPPOST <n> <url> <body> [max] bounded POST response
HTTPHEADER <n> <value> set/replace one of eight request headers
HTTPCLEAR              clear request headers
JSONESC <n> <text>     escape text for a JSON string; sets $jsonok
JSONGET <n> <json> <path> extract dotted/bracketed path; sets $jsonok

── files ───────────────────────────────────────────────────────────
FOPEN <path> <mode>    read | write | append | update; $fok = success
FCLOSE                 close (automatic at app end; FOPEN closes the previous)
FREAD <name>           one line → string variable; $feof = 1 at end of file
FWRITE <text>          write one line, $variables expanded
FREADB <name>          read one raw byte; $feof distinguishes NUL from EOF
FWRITEB <value>        write one raw byte (0..255)
FSEEK <offset>         absolute byte seek; $fok = success
FTELL <name>           current byte offset
FSIZE <name>           open file size
FEXISTS <n> <path>     1 → numeric variable if the path exists
FDELETE <path>         delete; $fok = success

── canvas ──────────────────────────────────────────────────────────
CANVAS <cols> <rows>   enter grid mode (max 120x60)
PUT <col> <row> <text> draw into the buffer in the current COLOR
FLIP                   show the buffer
ENDCANVAS              restore the terminal (automatic at app end)

── flow ────────────────────────────────────────────────────────────
:<name>                label  (alias LABEL <name>)
GOTO <label>           jump
GOSUB <label>          call; RETURN comes back (max 64 deep)
IF <l> <op> <r> GOTO|GOSUB <label>     numeric; = == != <> < <= > >=
IFEQ <l> <r> GOTO|GOSUB <label>        string equality
IFNE <l> <r> GOTO|GOSUB <label>        string inequality
WAIT <ms>              pause; resets the loop guard  (alias SLEEP)
EXIT                   end the app  (alias END)
```

## Appendix B — Limits and Built-ins

```text
4000       lines per app          64      numeric variables
256        labels                 32      string variables (4096 chars each)
16         arrays / 8192 cells    64      GOSUB depth
120 x 60   largest canvas         1       open file at a time
1000000    steps between WAITs before the loop guard trips
```

Every limit reports on the terminal when hit — including array indexes out of
range, which stop the app with the line number.

Built-ins: `$battery` `$cwd` `$heap` `$ip` `$millis` `$seconds` `$wifi`
`$ledok` `$audiook` `$httpok` `$httpcode` `$httplen` `$httptruncated`
`$jsonok`, the
file status pair `$fok` (last FOPEN/FDELETE/FSEEK worked) and `$feof`
(last FREAD hit end of file), and the key codes below.

## Appendix C — Key Codes

```text
0    nothing pressed            $kenter  5   enter
$kup     1   arrow up           $kesc    6   escape (also Ctrl+C, Ctrl+T)
$kdown   2   arrow down         $kback   8   backspace
$kleft   3   arrow left         $ktab    9   tab
$kright  4   arrow right        $kspace  32  space
32..126  printable keys, as ASCII: a=97, z=122, A=65, 0=48, p=112
Ctrl+X   never delivered — aborts the running app instead
```

## Appendix D — Answers

**1.1**
```text
COLOR red
PRINT "STOP"
WAIT 2000
COLOR yellow
PRINT "READY"
WAIT 1000
COLOR green
PRINT "GO"
```

**1.3** The quoted one keeps its spaces; the bare one is trimmed to `hi`.

**2.1**
```text
SET apples 7
SET oranges 5
SET fruit $apples
ADD fruit $oranges
PRINT "$fruit pieces of fruit"
```

**2.3**
```text
SET total 137
SET m $total
DIV m 60
SET s $total
MOD s 60
SETSTR out "$m"
APPEND out "m $s"
APPEND out "s"
PRINT $out
```
Why the `SETSTR`/`APPEND` dance? `PRINT "$mm $ss"` doesn't work — the
expander would read `$mm` as a variable *named* `mm`. A `$name` ends only at
a character that can't be part of a name, so gluing a letter directly after a
variable needs the string built in pieces. (There is no `${m}` escape syntax.)

**2.4** `DIV` truncates: 7÷2 → 3. Then 3 MOD 2 → 1.

**3.2**
```text
INPUT word "word? "
CHARAT first $word 0
LEN n $word
SUB n 1
CHARAT last $word $n
PRINT "first=$first last=$last"
```

**3.3** Control characters would move the cursor, ring bells, or start escape
sequences on the telnet client — a string could corrupt the terminal just by
being printed. Refusing them keeps every string printable.

**4.3**
```text
SET tries 0
:ask
INPUT ans "what is the capital of france? "
ADD tries 1
IFNE $ans "paris" GOTO ask
PRINT "correct, in $tries tries"
```

**4.4** Nothing in the loop ever changes `i` — the missing line is `ADD i 1`.
The exit test can never become true, and because the loop contains no `WAIT`,
the million-step guard is what finally kills it (that is its whole job:
catching loops that neither pause nor progress). Note the diagnosis in the
error message itself: *stopped after N steps* means "this loop never WAITed" —
your first question should always be "what did I forget to change?"

**5.1**
```text
SET n 1
:next
GOSUB factorial
PRINT "$n! = $fact"
ADD n 1
IF $n <= 8 GOTO next
EXIT

# in: n   out: fact
:factorial
SET fact 1
SET fi 1
:f_loop
MUL fact $fi
ADD fi 1
IF $fi <= $n GOTO f_loop
RETURN
```
(Note `fi`, not `i` — Chapter 5.2's naming advice, so the routine can't
trample a caller's counter.)

**5.4** Labels are **global, and the first definition in the file wins**. The
host program also had a `:done` — earlier in the file, in its main code. So
`GOTO done` inside the routine jumped not to the `:done` four lines down but
to the main program's, leaving the routine without `RETURN` — the Chapter 5.3
leak, one stranded return address per negative call, dying at depth 64. The
routine was innocent; its label's *name* was the bug. The defense is visible
all over `tetris.dapp`: every internal label wears its routine's name as a
prefix — `cellat_spin`, `collide_hit`, `hk_rot_ok`, `cl_next_row`. Do that
and two routines can never capture each other's jumps.

**6.3** `EXPR x 5 / 10` → 0.5 → rounds to **1**. With `floor()`: **0**.

**7.1**
```text
DIM rolls 6
SET i 0
:roll
RAND r 6
ADD rolls[$r] 1
ADD i 1
IF $i < 100 GOTO roll
SET f 0
:show
EXPR face $f + 1
PRINT "face $face: $rolls[$f]"
ADD f 1
IF $f < 6 GOTO show
```

**7.3** 19, not 20 — on a grid with odd width the diagonals share the center
cell, and setting it twice is still one cell. (Count cells that *are* 1,
don't count your `SET`s.)

**7.4** `index 5 outside a[0..4]`, plus the line number of the `PRINT`.

**8.3** `$dropat + 650` schedules from the *previous due time*: after a lag
spike the loop fires several gravity steps back-to-back to catch up.
`$millis + 650` schedules from *now* and quietly forgives the spike. For
Tetris, forgiving feels better; for a metronome or a clock, catching up is
correct — that is why both spellings exist.

**9.2** Without `CLS`, every old position stays drawn — the "ball" becomes a
growing snake of `o`s. The clear-and-redraw is what creates the illusion of
motion: each frame repaints the world as it is *now*, not as it has ever been.

**11.1**
```text
# count previous runs, then rewrite the whole file
SET runs 0
FEXISTS have "/apps/log.txt"
IF $have = 0 GOTO fresh
FOPEN "/apps/log.txt" read
IF $fok = 0 GOTO fresh
FREAD text
FCLOSE
GOSUB str2num
SET runs $num
:fresh
ADD runs 1
FOPEN "/apps/log.txt" write
IF $fok = 0 GOTO fail
FWRITE $runs
FWRITE "run $runs at $seconds seconds"
FCLOSE
PRINT "run number $runs"
EXIT
:fail
PRINT "couldn't write the log"
EXIT

# Chapter 5.4's routine, unchanged
:str2num
SET num 0
SET si 0
LEN slen $text
:s2n_loop
IF $si >= $slen GOTO s2n_done
CHARAT d $text $si
IF $d < 48 GOTO s2n_done
IF $d > 57 GOTO s2n_done
SUB d 48
MUL num 10
ADD num $d
ADD si 1
GOTO s2n_loop
:s2n_done
RETURN
```
(Note this rewrite drops the old entry lines — the count survives, the
entries don't. Keeping both is possible but means holding every line in
string variables while rewriting, and 32 string variables bounds how far
that scales. Real save files stay small on purpose.)

**11.2**
```text
FOPEN "/apps/log.txt" read
IF $fok = 0 GOTO missing
SET n 0
SET longest 0
:rl
FREAD line
IF $feof = 1 GOTO done
ADD n 1
LEN len $line
IF $len <= $longest GOTO rl
SET longest $len
GOTO rl
:done
FCLOSE
PRINT "$n lines, longest $longest chars"
EXIT
:missing
PRINT "no such file"
EXIT
```

**11.3** Before the ball's main loop: `SET delay 50`, then `FEXISTS` /
`FOPEN read` / `FREAD text` / `FCLOSE` / `GOSUB str2num` / `IF $num > 0` →
`SET delay $num` — the same tolerate-everything shape as tetris's `loadhs`.
Then `WAIT $delay` in the loop. (Guarding `$num > 0` matters: a garbled
config parsing to 0 would make `WAIT 0` — a loop the step guard will kill.)

**11.4** The handle is open for *writing* — `FREAD` against it is a
programming error, so the app stops. The correct sequence: `FWRITE`, then
`FCLOSE` (which is what actually commits the bytes), then `FOPEN ... read`.
The close in the middle is not ceremony — until it happens, the data may not
be on flash at all.

Chapters 8–9's remaining exercises, and everything in Chapter 10, are games —
their answer is the shipped `tetris.dapp`, and yours will be better.

---

*Written for the DOLL-OS shell's .dapp runtime. The reference card is
`/docs/dapp.txt` on the device; the worked example is `run tetris`.*
