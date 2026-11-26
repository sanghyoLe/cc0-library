import type { Asset } from "./types.js";

/**
 * Warnings for items whose CC0 label was set by an uploader. A CC0 tag does not
 * clear third-party rights: an uploader can tag a fan model of a game weapon or a
 * cartoon character as CC0, yet the franchise owner still holds copyright and
 * trademark in the design. These checks look only at the item's own title and
 * tags, so they catch obvious cases and miss the rest; no flag does not mean safe.
 *
 * Studio (`library`) and museum (`institution`) declarations are not checked:
 * the declarer made or holds the work.
 */

/**
 * Names of well-known commercial franchises, characters and brands, lowercased.
 * Names that are also ordinary words or terms (halo, blizzard, fallout, marvel,
 * joker, tesla, nike, half-life, ironman, minions) are left out: they flag too
 * many unrelated photos.
 * A name matches as whole words (multi-word names as a phrase); a trailing "*"
 * also matches longer words, for names commonly misspelled or inflected
 * ("frostmourn*" catches "Frostmourn" and "Frostmourne"). Multi-word names also
 * match written as one word, as tags often are ("starwars", "darthvader").
 */
const FRANCHISE_TERMS = [
  // games and game characters
  "pokemon", "pokémon", "pikachu", "nintendo", "mario", "luigi", "zelda", "hyrule", "kirby", "metroid", "donkey kong",
  "sonic the hedgehog", "sega", "minecraft", "fortnite", "roblox", "among us", "overwatch", "warcraft",
  "world of warcraft", "frostmourn*", "starcraft", "master chief", "call of duty",
  "grand theft auto", "final fantasy", "kingdom hearts", "elden ring", "dark souls", "skyrim", "the witcher",
  "cyberpunk 2077", "assassin's creed", "resident evil", "genshin", "league of legends", "valorant", "dota",
  "counter-strike", "portal gun", "tetris", "pac-man", "street fighter", "mortal kombat",
  "playstation", "xbox", "animal crossing", "splatoon", "undertale",
  // film, TV, comics, toys
  "star wars", "darth vader", "lightsaber", "stormtrooper", "clone trooper", "yoda", "jedi", "sith", "boba fett", "mandalor*",
  "x-wing", "tie fighter", "death star", "millennium falcon", "star trek", "avengers",
  "spider-man", "batman", "superman", "dc comics", "harry potter", "hogwarts",
  "lord of the rings", "gandalf", "hobbit", "game of thrones", "disney", "mickey mouse", "frozen elsa", "pixar",
  "toy story", "shrek", "simpsons", "spongebob", "transformers", "optimus prime", "lego", "barbie",
  "hello kitty", "studio ghibli", "totoro", "naruto", "dragon ball", "goku", "one piece", "sailor moon",
  "evangelion", "gundam", "doctor who", "tardis", "jurassic park", "godzilla", "ghostbusters", "james bond",
  "pirates of the caribbean", "indiana jones", "teenage mutant ninja turtles",
  // brands and logos
  "coca-cola", "pepsi", "mcdonald's", "adidas", "apple logo", "ferrari", "lamborghini",
  "porsche", "bmw", "mercedes-benz", "rolex", "louis vuitton", "gucci", "red bull",
];

/** Words in a title or tags that say the item copies someone else's work. */
const DERIVATIVE_TERMS = ["fan art", "fan made", "ripped", "sprite rip", "replica", "inspired by"];

/** Lowercase words separated by single spaces; hyphens count as spaces ("fan-art" = "fan art"). */
function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}'*]+/gu, " ").trim()} `;
}

function matches(haystack: string, term: string): boolean {
  if (term.endsWith("*")) return new RegExp(`(^|\\s)${escape(term.slice(0, -1))}`, "u").test(haystack);
  const t = normalize(term).trim();
  if (haystack.includes(` ${t} `)) return true;
  const joined = t.replace(/ /g, "");
  return joined !== t && haystack.includes(` ${joined} `);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Flags for one asset; empty when nothing matched or the declarer is not an uploader. */
export function riskFlags(asset: Pick<Asset, "title" | "tags" | "licenseEvidence">): string[] {
  if (asset.licenseEvidence.declaredBy !== "uploader") return [];
  const text = normalize([asset.title, ...asset.tags].join(" "));
  const flags: string[] = [];
  const franchise = FRANCHISE_TERMS.filter((t) => matches(text, t));
  if (franchise.length) flags.push(`franchise-name: ${franchise.map((t) => t.replace(/\*$/, "")).join(", ")}`);
  const derivative = DERIVATIVE_TERMS.filter((t) => matches(text, t));
  if (derivative.length) flags.push(`derivative-wording: ${derivative.join(", ")}`);
  return flags;
}

/** Returns the asset with `riskFlags` set when any check matched, otherwise unchanged. */
export function withRiskFlags<T extends Asset>(asset: T): T {
  const flags = riskFlags(asset);
  return flags.length ? { ...asset, riskFlags: flags } : asset;
}
