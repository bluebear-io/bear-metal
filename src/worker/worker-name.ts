const NICKNAMES = [
  "one_eyed",
  "two_toes",
  "three_fingers",
  "cannonball",
  "ironjaw",
  "barnacle",
  "trigger_finger",
  "cutlass",
  "dead_eye",
  "black_powder",
  "rusty_hook",
  "salted",
  "scurvy",
  "pegleg",
  "bilge_rat",
  "plank_walking",
  "shark_bitten",
  "gold_tooth",
  "tattooed",
  "hangman",
];

const FIRST_NAMES = [
  "ned",
  "tommy",
  "johnny",
  "tim",
  "molly",
  "jack",
  "sal",
  "pete",
  "mary",
  "dan",
  "lou",
  "rita",
  "hank",
  "bess",
  "crow",
  "wade",
  "mick",
  "nora",
  "flint",
  "gus",
];

export function generateWorkerName(): string {
  const nickname = NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)]!;
  const name = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]!;
  return `${nickname}_${name}`;
}
