import { NextResponse } from "next/server";

/**
 * Server-side proxy for Google Places Autocomplete (New).
 *
 * Why a proxy: GOOGLE_MAPS_API_KEY is a server-only secret. By calling Google
 * from here we avoid shipping the key in the browser bundle.
 *
 * Where to set the key:
 *   - Local dev:  .env.local       (GOOGLE_MAPS_API_KEY=AIza...)
 *   - Production: Vercel env vars  (GOOGLE_MAPS_API_KEY=AIza..., not NEXT_PUBLIC)
 *
 * In Google Cloud Console enable the "Places API (New)" service and restrict
 * the key to that API.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const bias = url.searchParams.get("bias") ?? "";

  if (!q || q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return NextResponse.json(
      {
        suggestions: [],
        error: "missing_key",
        message:
          "Address autocomplete is not configured. Set GOOGLE_MAPS_API_KEY in your environment.",
      },
      { status: 503 },
    );
  }

  type Body = {
    input: string;
    locationBias?: {
      circle: { center: { latitude: number; longitude: number }; radius: number };
    };
  };
  const body: Body = { input: q };
  if (bias) {
    const [lat, lng] = bias.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      body.locationBias = {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: 50_000, // 50 km
        },
      };
    }
  }

  try {
    const res = await fetch(
      "https://places.googleapis.com/v1/places:autocomplete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text",
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return NextResponse.json(
        {
          suggestions: [],
          error: "google_error",
          status: res.status,
          message: errText.slice(0, 500) || "Google Places returned an error.",
        },
        { status: 502 },
      );
    }

    type GoogleResponse = {
      suggestions?: Array<{
        placePrediction?: {
          placeId: string;
          text?: { text: string };
          structuredFormat?: {
            mainText?: { text: string };
            secondaryText?: { text: string };
          };
        };
      }>;
    };
    const data = (await res.json()) as GoogleResponse;
    const suggestions = (data.suggestions ?? [])
      .map((s) => {
        const pp = s.placePrediction;
        if (!pp) return null;
        return {
          place_id: pp.placeId,
          description: pp.text?.text ?? "",
          main_text: pp.structuredFormat?.mainText?.text ?? pp.text?.text ?? "",
          secondary_text: pp.structuredFormat?.secondaryText?.text ?? "",
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return NextResponse.json({ suggestions });
  } catch (err) {
    return NextResponse.json(
      {
        suggestions: [],
        error: "network_error",
        message: err instanceof Error ? err.message : "Network error",
      },
      { status: 502 },
    );
  }
}
