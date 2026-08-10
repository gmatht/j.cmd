// linked_list.c — a C linked-list generator + sink, driven by bash.
//
// THE C SIDE
//   struct Node { char *word; struct Node *next; } — a real heap-linked
//   list. `p->member` reads/writes the runtime mem arena at the member's
//   byte offset (malloc(sizeof(struct Node)) → 16 bytes: word at 0,
//   next at 8). NULL is the empty string; `while (list != 0)` is the
//   pointer-non-null test.
//
//   gen_line(word) — the GENERATOR: prepends one node (LIFO — the list
//   ends up in reverse input order).
//   sink()          — the SINK: drains the list head-to-tail, printing
//   each word. Prepend + head-to-tail = REVERSED input.
//   slurp()         — reads stdin LINES with the STANDARD getline(&b,
//   &bufsize, stdin) (lowered to the runtime getLine bridge: fills b,
//   returns the count, -1 at EOF) and feeds gen_line.
//   main()          — slurp + sink: reads stdin, reverses it, prints.
//
// THE BASH SIDE (the demo): bash combines the two over a pipe — the
// generator slurps stdin, the sink emits the reversed lines:
//
//   printf 'three\ntwo\none\n' | source /examples/c/linked_list.c
//   → one
//     two
//     three
//
//   # or build the list a word at a time and sink it later:
//   source /examples/c/linked_list.c
//   for w in alpha beta gamma; do gen_line "$w"; done
//   sink            → gamma beta alpha
//
//   # the IDIOMATIC form: capture slurp2's output (the head's mem handle
//   # — an opaque string; the pointer IS a name) into a bash variable and
//   # pass the pointer back in:
//   linkedlist=$(printf 'three\ntwo\none\n' | slurp2)   # slurp2 reads the pipe, prints the handle
//   sink2 $linkedlist      → one two three
//   # (slurp2 also leaves the handle in the $last global, so a direct
//   # `printf … | slurp2` followed by `sink2 "$last"` works too)
//
// NOTE: this exercises the c-sh-go TRANSPILER (struct pointers, the
// `->` member lowering, getline) — it does not compile with `cc`.
#include <stdio.h>

struct Node { char *word; struct Node *next; };

struct Node *list = 0;
struct Node *last = 0;   // slurp2 also leaves the fresh head here — bash can read $last

int gen_line(char *word) {
  struct Node *n = malloc(sizeof(struct Node));
  n->word = word;
  n->next = list;
  list = n;
  return 0;
}

int sink() {
  while (list != 0) {
    printf("%s\n", list->word);
    list = list->next;
  }
  return 0;
}

int slurp() {
  char *b;
  unsigned long bufsize = 0;
  int characters;
  characters = getline(&b, &bufsize, stdin);
  while (characters != -1) {
    gen_line(b);
    characters = getline(&b, &bufsize, stdin);
  }
  return 0;
}

// slurp2 — like slurp, but builds the list in a LOCAL head and RETURNS
// the list to bash: `printf "%s" head` prints the head node's mem handle
// (an opaque string — bash holds it in a variable; a pointer IS a name).
//   p=$(slurp2)      # slurp2 reads stdin, prints the head handle
//   sink2 "$p"       # the same list, drained from the pointer
int slurp2() {
  struct Node *head = 0;
  char *b;
  unsigned long bufsize = 0;
  int characters;
  characters = getline(&b, &bufsize, stdin);
  while (characters != -1) {
    struct Node *n = malloc(sizeof(struct Node));
    n->word = b;
    n->next = head;
    head = n;
    characters = getline(&b, &bufsize, stdin);
  }
  last = head;
  printf("%s", head);
  return 0;
}

// find — DYNAMICALLY WALKS a list passed in by pointer (the handle bash
// holds): follow p->next at runtime until the word matches — the arena
// stores the NEXT handle in the node, so the walk is a live dereference,
// not a compile-time shape:
//   find "$linkedlist" fig
int find(struct Node *head, char *target) {
  struct Node *p = head;
  int index = 0;
  while (p != 0) {
    if (strcmp(p->word, target) == 0) {
      printf("found %s at %d\n", p->word, index);
      return 0;
    }
    p = p->next;
    index = index + 1;
  }
  printf("not found: %s\n", target);
  return 0;
}

// sink2 — drains a list passed in BY POINTER (the handle bash holds):
//   sink2 "$p"
int sink2(struct Node *head) {
  struct Node *p = head;
  while (p != 0) {
    printf("%s\n", p->word);
    p = p->next;
  }
  return 0;
}

int main() {
  char *b;
  unsigned long bufsize = 0;
  int characters;
  characters = getline(&b, &bufsize, stdin);
  if (characters < 0) {
    printf("linked_list.c — a C linked-list generator + sink (sourced into this shell)\n");
    printf("\n");
    printf("  pipe stdin through it — reverses the lines:\n");
    printf("    printf 'three\ntwo\none\n' | source /examples/c/linked_list.c\n");
    printf("\n");
    printf("  hold the list in a bash VARIABLE (the head's mem handle) and pass the pointer back:\n");
    printf("    linkedlist=$(printf 'four\nthree\ntwo\none\n' | slurp2); sink2 $linkedlist\n");
    printf("\n");
    printf("  or build it a word at a time and sink later:\n");
    printf("    for w in alpha beta gamma; do gen_line \"$w\"; done; sink\n");
  } else {
    gen_line(b);
    characters = getline(&b, &bufsize, stdin);
    while (characters >= 0) {
      gen_line(b);
      characters = getline(&b, &bufsize, stdin);
    }
    sink();
  }
  return 0;
}
