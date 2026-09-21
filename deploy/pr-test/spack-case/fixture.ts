const cases = {
  hello: {
    id: "hello",
    name: "hello",
    version: "2.12.1",
    spec: "hello@2.12.1",
    repository: "public/pr-hello-sources",
    recipes: "public/pr-hello-recipes",
    retiredSpec: "hello@0.0.0",
  },
  samtools: {
    id: "samtools",
    name: "samtools",
    version: "1.19.2",
    spec: "samtools@1.19.2 ^htslib@1.19.1~libcurl~libdeflate ^ncurses+symlinks %pkgconf ^zlib@1.3.1",
    repository: "public/pr-samtools-sources",
    recipes: "public/pr-samtools-recipes",
    retiredSpec: "samtools@0.0.0",
  },
} as const;

export type AcceptanceCase = (typeof cases)[keyof typeof cases];

export function selectedCase(value = process.env.KQ_PR_SPACK_CASE ?? "hello"): AcceptanceCase {
  if (value !== "hello" && value !== "samtools") {
    throw new Error("Unsupported PR Spack acceptance case");
  }
  return cases[value];
}
