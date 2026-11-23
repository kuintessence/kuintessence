declare module "lobos" {
  export class Sobol {
    constructor(dimensions: number);
    readonly next: number[];
  }
}
