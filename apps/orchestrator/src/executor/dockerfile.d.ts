/**
 * A Dockerfile imported as text (`with { type: "text" }`): Bun reads it at run time from a checkout
 * and inlines it into `bun build`'s bundle, so the published orchestrator carries it too.
 */
declare module "*/Dockerfile" {
  const text: string;
  export default text;
}
