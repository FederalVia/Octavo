// @mixmark-io/domino ships types under the name "domino", so declare the real package name here.
declare module '@mixmark-io/domino' {
  const domino: { createDocument(html?: string, force?: boolean): Document };
  export default domino;
}
