// esbuild bundles the imported stylesheet into dist/renderer.css; TypeScript
// only needs to know the side-effect import is legitimate.
declare module "*.css";
// Markdown imports (docs/pet-guide.md) are inlined as text by esbuild.
declare module "*.md" {
  const text: string;
  export default text;
}
