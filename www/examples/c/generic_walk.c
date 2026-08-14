// generic_walk.c — a GENUINELY GENERIC walker over any tagged linked
// structure. The walker knows NOTHING about the structure's layout: it
// reads member k of a malloc'd box through the layout registry
// (nodeChild — resolved by the box's tag at runtime), and follows the
// "next" member until the chain ends.
//
//   source /examples/c/generic_walk.c
//   source /examples/c/linked_list.c        # build a Node list
//   linkedlist=$(printf 'three\ntwo\none\n' | slurp2)
//   generic_count $linkedlist               -> 3
//   generic_tag  $linkedlist                -> Tag-<hash> (the box's tag)
//   generic_find $linkedlist one            -> found one at index 2
//
// (generic_find works on ANY tagged struct with a string member at k=0
// and a "next" pointer at k=1 — add a `struct Tree` and it walks trees
// with the same code.)
#include <stdio.h>

struct Node { char *word; struct Node *next; };

// generic_count — follow the "next" member (k=1) until NULL; count.
int generic_count(void *p) {
  int n = 0;
  while (p != 0) {
    n = n + 1;
    p = nodeChild(p, 1);
  }
  return n;
}

// generic_find — walk p, compare member k=0 against target.
int generic_find(void *p, char *target) {
  int index = 0;
  while (p != 0) {
    if (strcmp(nodeData(p, 0), target) == 0) {
      printf("found %s at %d\n", nodeData(p, 0), index);
      return 0;
    }
    p = nodeChild(p, 1);
    index = index + 1;
  }
  printf("not found\n");
  return 1;
}

int main() {
  printf("generic_walk.c — a walker that knows NO layout (nodeChild/nodeData)\n");
  printf("  source this, then build a list and walk it generically:\n");
  printf("    linkedlist=$(printf 'three\\ntwo\\none\\n' | slurp2)\n");
  printf("    generic_count $linkedlist   -> the number of nodes\n");
  printf("    generic_find  $linkedlist one -> found one at index 2\n");
  printf("    generic_tag   $linkedlist   -> the box's Tag-<hash> key\n");
  return 0;
}
