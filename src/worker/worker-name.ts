const FIRST_NAMES = [
  // Israeli
  "Noa", "Lior", "Tamar", "Idan", "Shira", "Rotem", "Eitan", "Yael",
  // American
  "Jake", "Emily", "Tyler", "Chloe", "Mason", "Olivia", "Ethan", "Lily",
  // Funny nicknames
  "Buster", "Patches", "Turbo", "Ziggy",
];

const LAST_NAMES = [
  // Israeli
  "Cohen", "Levi", "Mizrahi", "Goldberg", "Shapiro", "Katz", "Ben-David", "Friedman",
  // American
  "Mitchell", "Hayes", "Sullivan", "Parker", "Brennan", "McTavish", "Gallagher", "Lawson",
  // Funny nicknames
  "Thunderbolt", "Waffles", "Bananaman", "McFluffin",
];

export function generateWorkerName(): string {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]!;
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)]!;
  return `${first} ${last}`;
}
