#include "x68.h"

enum {
  kNoKey = 0,
  kLeftKey,
  kUpKey,
  kRightKey,
  kDownKey,
  kSpaceKey,
  kEnterKey,
  kEscapeKey,
  kAKey,
  kOneKey,
};

static int ReadPressedKey(void) {
  if (x68_key_down(X68_KEY_LEFT)) return kLeftKey;
  if (x68_key_down(X68_KEY_UP)) return kUpKey;
  if (x68_key_down(X68_KEY_RIGHT)) return kRightKey;
  if (x68_key_down(X68_KEY_DOWN)) return kDownKey;
  if (x68_key_down(X68_KEY_SPACE)) return kSpaceKey;
  if (x68_key_down(X68_KEY_ENTER)) return kEnterKey;
  if (x68_key_down(X68_KEY_ESC)) return kEscapeKey;
  if (x68_key_down(X68_KEY_A)) return kAKey;
  if (x68_key_down(X68_KEY_1)) return kOneKey;
  return kNoKey;
}

static void PrintKeyName(int key) {
  switch (key) {
    case kNoKey:
      printf("\n[RELEASE]");
      break;
    case kLeftKey:
      printf("\n[LEFT]");
      break;
    case kUpKey:
      printf("\n[UP]");
      break;
    case kRightKey:
      printf("\n[RIGHT]");
      break;
    case kDownKey:
      printf("\n[DOWN]");
      break;
    case kSpaceKey:
      printf("\n[SPACE]");
      break;
    case kEnterKey:
      printf("\n[ENTER]");
      break;
    case kEscapeKey:
      printf("\n[ESC]");
      break;
    case kAKey:
      printf("\n[A]");
      break;
    default:
      printf("\n[1]");
      break;
  }
}

void main(void) {
  int previous = kNoKey;

  x68_screen_open();
  printf("[READY]");
  for (;;) {
    int current = ReadPressedKey();
    if (current != previous) {
      PrintKeyName(current);
      previous = current;
    }
  }
}
