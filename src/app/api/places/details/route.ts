import { NextResponse } from "next/server";

/**
 * Server-side proxy for Google Place Details (New).
 * Returns just the bits we need: formatted address + lat/lng.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const placeId = url.searchParams.get("place_id")?.trim() ?? "";

  if (!placeId) {
    return NextResponse.json({ error: "missing_place_id" }, { status: 400 });
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return NextResponse.json(
      {
        error: "missing_key",
        message:
          "Address lookup is not configured. Set GOOGLE_MAPS_API_KEY in your environment.",
      },
      { status: 503 },
    );
  }

  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "id,formattedAddress,location",
        },
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return NextResponse.json(
        {
          error: "google_error",
          status: res.status,
          message: errText.slice(0, 500) || "Google Places returned an error.",
        },
        { status: 502 },
      );
    }

    type GoogleResponse = {
      formattedAddress?: string;
      location?: { latitude: number; longitude: number };
    };
    const data = (await res.json()) as GoogleResponse;
    return NextResponse.json({
      address: data.formattedAddress ?? "",
      lat: data.location?.latitude ?? null,
      lng: data.location?.longitude ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "network_error",
        message: err instanceof Error ? err.message : "Network error",
      },
      { status: 502 },
    );
  }
}
