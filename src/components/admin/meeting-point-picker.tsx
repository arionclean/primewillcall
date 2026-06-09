"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

// Leaflet touches `window`, so the map must only render on the client.
const MeetingPointMap = dynamic(() => import("./meeting-point-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[320px] w-full items-center justify-center rounded-md border bg-muted/30 text-sm text-muted-foreground">
      Loading map...
    </div>
  ),
});

type Suggestion = {
  place_id: string;
  description: string;
  main_text: string;
  secondary_text: string;
};

type LatLng = { lat: number; lng: number };

const DEFAULT_CENTER: LatLng = { lat: 25.7617, lng: -80.1918 }; // Miami

type AutocompleteState = "idle" | "ready" | "unavailable";

type MeetingPointPickerProps = {
  defaultAddress?: string | null;
  defaultLat?: number | null;
  defaultLng?: number | null;
};

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M16.704 5.296a1 1 0 0 1 0 1.408l-8 8a1 1 0 0 1-1.408 0l-4-4a1 1 0 1 1 1.408-1.408L8 12.59l7.296-7.295a1 1 0 0 1 1.408 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function MeetingPointPicker({
  defaultAddress,
  defaultLat,
  defaultLng,
}: MeetingPointPickerProps) {
  // The address text we'll save with the pin. Updated when the user types or
  // picks a suggestion. We never overwrite it from reverse-geocoding because
  // the user picked or typed it deliberately.
  const [address, setAddress] = useState<string>(defaultAddress ?? "");
  // What's currently in the search input. Same as `address` most of the time.
  const [searchQuery, setSearchQuery] = useState<string>(defaultAddress ?? "");
  // True after the user picks a Google suggestion (drives the address checkmark).
  const [addressConfirmed, setAddressConfirmed] = useState<boolean>(
    Boolean(defaultAddress),
  );
  // Picker collapses to a one-line summary when there's already a saved
  // meeting point, expands to the full address+map UI when the user edits.
  const hasInitialMeetingPoint =
    Boolean(defaultAddress) && defaultLat != null && defaultLng != null;
  const [expanded, setExpanded] = useState<boolean>(!hasInitialMeetingPoint);

  // The saved/committed pin. Only set after the user clicks the map.
  const [pin, setPin] = useState<LatLng | null>(
    defaultLat != null && defaultLng != null
      ? { lat: defaultLat, lng: defaultLng }
      : null,
  );
  // Where the map view should be focused. Updated when the user picks an
  // autocomplete suggestion (without setting a pin) or when the pin moves.
  const [mapCenter, setMapCenter] = useState<LatLng>(
    pin ?? DEFAULT_CENTER,
  );
  // Whether the user has interacted with autocomplete in this session and is
  // therefore expected to drop a pin next. Drives the "click the map" hint.
  const [awaitingClick, setAwaitingClick] = useState<boolean>(false);

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searching, setSearching] = useState(false);
  const [autocompleteState, setAutocompleteState] =
    useState<AutocompleteState>("idle");
  const skipNextSearch = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read mapCenter via ref so map clicks don't re-fire the search effect.
  const mapCenterRef = useRef(mapCenter);
  useEffect(() => {
    mapCenterRef.current = mapCenter;
  }, [mapCenter]);
  // Cancel any in-flight autocomplete fetch when the user picks or types again
  // so a slow response can never repopulate the dropdown after the fact.
  const abortRef = useRef<AbortController | null>(null);

  // Debounced address search via /api/places/autocomplete. Only re-runs when
  // the user's typed query changes — NOT when the map moves. Skipped entirely
  // when the address is already confirmed (e.g. on edit page load).
  useEffect(() => {
    if (addressConfirmed) return;
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    if (!searchQuery || searchQuery.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setSearching(true);
      try {
        const c = mapCenterRef.current;
        const bias = c ? `&bias=${c.lat},${c.lng}` : "";
        const res = await fetch(
          `/api/places/autocomplete?q=${encodeURIComponent(searchQuery)}${bias}`,
          { signal: controller.signal },
        );
        const json = (await res.json().catch(() => ({}))) as {
          suggestions?: Suggestion[];
          error?: string;
        };

        if (res.status === 503 && json.error === "missing_key") {
          setAutocompleteState("unavailable");
          setSuggestions([]);
          return;
        }
        if (!res.ok) {
          setSuggestions([]);
          return;
        }
        setAutocompleteState("ready");
        setSuggestions(json.suggestions ?? []);
        setShowSuggestions(true);
      } catch (err) {
        // Abort is expected when the user picks or types again — ignore.
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setSuggestions([]);
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setSearching(false);
      }
    }, 350);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [searchQuery, addressConfirmed]);

  async function pickSuggestion(s: Suggestion) {
    // Kill any in-flight autocomplete fetch so it can't repopulate the dropdown
    // after we've cleared it here.
    if (abortRef.current) abortRef.current.abort();
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    skipNextSearch.current = true;
    setAddress(s.description);
    setSearchQuery(s.description);
    setShowSuggestions(false);
    setSuggestions([]);
    setAddressConfirmed(true);

    // Fetch lat/lng for the picked place, then pan the map there without
    // setting a pin. The user clicks the map next to confirm the exact spot.
    try {
      const res = await fetch(
        `/api/places/details?place_id=${encodeURIComponent(s.place_id)}`,
      );
      const json = (await res.json().catch(() => ({}))) as {
        lat?: number | null;
        lng?: number | null;
        address?: string;
      };
      if (
        typeof json.lat === "number" &&
        typeof json.lng === "number" &&
        Number.isFinite(json.lat) &&
        Number.isFinite(json.lng)
      ) {
        setMapCenter({ lat: json.lat, lng: json.lng });
        // Clear any previously-committed pin since the search moved us
        // somewhere new. The user must click to commit a fresh pin.
        setPin(null);
        setAwaitingClick(true);
        // Prefer the formatted address from Google over the autocomplete text
        // since it's more canonical. Guard the next-search effect so this
        // second setSearchQuery doesn't reopen the dropdown.
        if (json.address) {
          skipNextSearch.current = true;
          setAddress(json.address);
          setSearchQuery(json.address);
        }
      }
    } catch {
      // ignore; user can still click the map manually
    }
  }

  function handleMapChange(next: LatLng) {
    setPin(next);
    setMapCenter(next);
    setAwaitingClick(false);
  }

  if (!expanded) {
    return (
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Meeting point
            </p>
            <p className="mt-0.5 truncate text-sm font-medium">
              {address || "Set address"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Edit
          </button>
        </div>
        {/* Keep hidden inputs in DOM so the form still submits when collapsed. */}
        <input type="hidden" name="meeting_point_address" value={address} />
        <input
          type="hidden"
          name="meeting_point_lat"
          value={pin ? String(pin.lat) : ""}
        />
        <input
          type="hidden"
          name="meeting_point_lng"
          value={pin ? String(pin.lng) : ""}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field
        label="Meeting point address"
        htmlFor="meeting_point_address_search"
        hint={
          autocompleteState === "unavailable"
            ? "Address autocomplete is not configured. Click the map below to drop a pin manually."
            : undefined
        }
      >
        <div className="relative">
          <Input
            id="meeting_point_address_search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setAddress(e.target.value);
              setShowSuggestions(true);
              setAddressConfirmed(false);
            }}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            placeholder="e.g. Bayside Marketplace, Miami, FL"
            autoComplete="off"
            className={addressConfirmed ? "pr-10" : undefined}
          />
          {addressConfirmed ? (
            <CheckIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-in fade-in zoom-in-50 duration-200 text-emerald-600" />
          ) : searching ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              ...
            </span>
          ) : null}
          {showSuggestions && suggestions.length > 0 && (
            // Leaflet panes/controls reach z-index 700-1000, so we sit above them.
            <ul className="absolute z-[2000] mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
              {suggestions.map((s) => (
                <li key={s.place_id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickSuggestion(s)}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <div className="font-medium">{s.main_text}</div>
                    {s.secondary_text && (
                      <div className="text-xs text-muted-foreground">
                        {s.secondary_text}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Field>

      {/* Show the map only once we have something meaningful to show:
       *  - the user picked an autocomplete suggestion (we have a center)
       *  - a pin is already set (existing tour being edited, or fresh click)
       *  - autocomplete is unavailable so the user has no other entry point
       */}
      {(awaitingClick || pin || autocompleteState === "unavailable") ? (
        <>
          {awaitingClick && (
            <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
              Click the exact spot on the map to drop the meeting point pin.
            </p>
          )}
          {!awaitingClick && pin && (
            <p
              key="pin-set"
              className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
            >
              <CheckIcon className="h-3.5 w-3.5 shrink-0 animate-in fade-in zoom-in-50 duration-200 text-emerald-600 dark:text-emerald-400" />
              Pin set. Drag it on the map to adjust.
            </p>
          )}
          <MeetingPointMap
            value={pin}
            center={mapCenter}
            onChange={handleMapChange}
          />
        </>
      ) : (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Search for an address above. A map will appear so you can drop the
          exact meeting point pin.
        </p>
      )}

      {hasInitialMeetingPoint && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Done editing
        </button>
      )}

      <input type="hidden" name="meeting_point_address" value={address} />
      <input
        type="hidden"
        name="meeting_point_lat"
        value={pin ? String(pin.lat) : ""}
      />
      <input
        type="hidden"
        name="meeting_point_lng"
        value={pin ? String(pin.lng) : ""}
      />
    </div>
  );
}
