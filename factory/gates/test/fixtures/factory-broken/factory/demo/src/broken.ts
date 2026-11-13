// Factory code with a lint error and a type error: the gates check only the app, so neither counts.
const unused = 1;
export const broken: number = "not a number";
