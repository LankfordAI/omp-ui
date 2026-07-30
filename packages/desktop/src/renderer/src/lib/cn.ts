import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Conditional classes with later Tailwind utilities winning conflicts. */
export function cn(...parts: ClassValue[]): string {
  return twMerge(clsx(parts));
}
