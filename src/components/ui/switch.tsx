"use client";

/**
 * An on/off switch. With `name`, it also submits its value via a hidden input.
 * Shared by the messaging flow and the booking sources screen.
 */
export function Switch({
  checked,
  onChange,
  name,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  name?: string;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <>
      {name ? <input type="hidden" name={name} value={checked ? "1" : "0"} /> : null}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative inline-flex shrink-0 cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
        style={{
          width: 36,
          height: 20,
          borderRadius: 9999,
          padding: 2,
          backgroundColor: checked ? "#10b981" : "rgba(115, 115, 115, 0.35)",
          transition: "background-color 150ms ease",
          border: "none",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 16,
            height: 16,
            borderRadius: 9999,
            backgroundColor: "#ffffff",
            boxShadow: "0 1px 2px rgba(0, 0, 0, 0.2)",
            transform: checked ? "translateX(16px)" : "translateX(0)",
            transition: "transform 150ms ease",
          }}
        />
      </button>
    </>
  );
}
