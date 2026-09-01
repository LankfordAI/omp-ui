import { en } from "./en";

/** Every catalog key; component t() calls are typed against this. */
export type MessageKey = keyof typeof en;
