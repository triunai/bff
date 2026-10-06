"""The one rule for every [Y/n] prompt: EOF is never consent.

`readline()` returns "" only at end of file (Ctrl-D, a closed terminal); a bare Enter returns "\\n".
Enter is the default yes, `y`/`yes` in any case is yes, everything else, EOF included, is no.
install.py mirrors `answer_is_yes` privately (it must import before this package exists); a fitness test
keeps the two in agreement.
"""


def answer_is_yes(line):
    if line == "":
        return False
    return line.strip().lower() in ("", "y", "yes")


def confirm(question, stdin, out):
    out.write(question)
    out.flush()
    return answer_is_yes(stdin.readline())
