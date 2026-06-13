const FIRST_NAMES = [
  // American
  "Jake", "Emily", "Tyler", "Chloe", "Mason", "Olivia", "Ethan", "Lily",
  // Pirate
  "Blackbeard", "Calico", "Jolly", "Scurvy", "Pegleg", "Cannonball", "Barnacle", "Salty",
  // College football
  "Touchdown", "Blitz", "Spike", "Fumble", "Gunslinger", "Crusher", "Tank", "Rocket",
  // Extra funny
  "Buster", "Patches", "Turbo", "Ziggy", "Noodles", "Biscuit", "Corndog", "Pickles",
];

const LAST_NAMES = [
  // American
  "Mitchell", "Hayes", "Sullivan", "Parker", "Brennan", "McTavish", "Gallagher", "Lawson",
  // Pirate
  "Plank", "Davy Jones", "Blackwater", "Ironhook", "Stormcrow", "Keel", "Broadside", "Foulweather",
  // College football
  "Blitzkrieg", "Gridiron", "Endzone", "Linebacker", "Hailmary", "Pigskin", "Fumblesworth", "Touchdownski",
  // Extra funny
  "Thunderbolt", "Waffles", "Bananaman", "McFluffin", "Noodlearms", "von Snuggles", "Biscuithead", "Corndog",
];

export function generateWorkerName(): string {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]!;
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)]!;
  return `${first} ${last}`;
}
