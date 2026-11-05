// Types and schemas shared by the server and the web app. Anything that crosses the
// HTTP boundary belongs here, so a change to its shape fails the typecheck on both sides.
export * from './types.js';
