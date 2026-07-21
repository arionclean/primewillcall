import { cn } from "@/lib/utils";

/**
 * Gradient-circle avatar with a color picked deterministically from `seed`,
 * so the same person always gets the same gradient. Seed with something
 * stable like the email; names can be edited.
 */

const GRADIENTS = [
  "from-pink-300 to-purple-500",
  "from-sky-300 to-indigo-500",
  "from-amber-300 to-orange-500",
  "from-emerald-300 to-teal-500",
  "from-rose-300 to-red-500",
  "from-violet-300 to-fuchsia-500",
  "from-cyan-300 to-blue-500",
  "from-lime-300 to-green-600",
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function Avatar({
  seed,
  className,
}: {
  seed: string;
  className?: string;
}) {
  const gradient = GRADIENTS[hashString(seed) % GRADIENTS.length];

  return (
    <div
      aria-hidden
      className={cn(
        "h-10 w-10 shrink-0 rounded-full bg-gradient-to-br",
        gradient,
        className,
      )}
    />
  );
}
