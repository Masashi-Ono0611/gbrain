/** `import s from "./x.sh" with { type: "text" }`: a bundled skill script as text (local skill scripts, patch 207). */
declare module '*.sh' {
  const content: string;
  export default content;
}
