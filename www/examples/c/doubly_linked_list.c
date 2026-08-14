// doubly_linked_list.c — a doubly linked list: every node carries BOTH
// a `prev` and a `next` pointer, so the pointer graph is cyclic (the
// back-edges). The shell walks it like a filesystem anyway:
//
//   source /examples/c/doubly_linked_list.c
//   add one; add two; add three
//   print_fwd        → one two three
//   print_rev        → three two one
//   cd $head         → enter the list head as a directory
//   ls               → word  prev/  next/
//   find .           → terminates (the prev back-edge is a visited box,
//                      so it is shown but not re-walked)
//   grep two .       → ./next/word:two
//
// The `prev` member is a real back-pointer written into the arena
// (memStore at byte offset 8), so the cycle is live data, not a lie.
#include <stdio.h>

struct Node { char *word; struct Node *prev; struct Node *next; };

struct Node *head = 0;
struct Node *tail = 0;

// add WORD — append a node at the tail: the new node's prev is the old
// tail, the old tail's next is the new node.
int add(char *word) {
  struct Node *n = malloc(sizeof(struct Node));
  n->word = word;
  n->prev = tail;
  n->next = 0;
  if (tail != 0) {
    tail->next = n;
  } else {
    head = n;
  }
  tail = n;
  return 0;
}

// print_fwd — head → tail via the `next` pointers.
int print_fwd() {
  struct Node *p = head;
  while (p != 0) {
    printf("%s ", p->word);
    p = p->next;
  }
  printf("\n");
  return 0;
}

// print_rev — tail → head via the `prev` pointers (the back-edges).
int print_rev() {
  struct Node *p = tail;
  while (p != 0) {
    printf("%s ", p->word);
    p = p->prev;
  }
  printf("\n");
  return 0;
}

int main() {
  printf("doubly_linked_list.c — a doubly linked list (prev + next)\n");
  printf("\n");
  printf("  add one two three; print_fwd; print_rev\n");
  printf("  cd $head; ls; find .   (terminates — prev back-edges are skipped)\n");
  printf("\n");
  printf("  demo (this run):\n");
  add("one");
  add("two");
  add("three");
  printf("  fwd:  ");
  print_fwd();
  printf("  rev:  ");
  print_rev();
  printf("\n");
  return 0;
}
