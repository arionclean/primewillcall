"use client";

import "leaflet/dist/leaflet.css";

import L from "leaflet";
import { useEffect } from "react";
import {
  MapContainer,
  Marker,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";

// react-leaflet does not bundle the default marker images correctly with
// Turbopack / webpack. Point them at the CDN so they render.
delete ((L.Icon.Default.prototype as unknown) as { _getIconUrl?: unknown })
  ._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

type LatLng = { lat: number; lng: number };

type MeetingPointMapProps = {
  /** The committed/saved pin. If null, no pin is rendered. */
  value: LatLng | null;
  /** Where the map view should be centered. May differ from value when the
   *  user has searched an address but not yet clicked to drop a pin. */
  center: LatLng;
  /** Zoom level when no pin is set yet (e.g. 13 = neighborhood). */
  centerZoom?: number;
  /** Zoom level when a pin is set (e.g. 16 = pin-precise). */
  pinZoom?: number;
  onChange: (next: LatLng) => void;
};

function ClickAndDragLayer({
  value,
  onChange,
}: {
  value: LatLng | null;
  onChange: (next: LatLng) => void;
}) {
  useMapEvents({
    click(e) {
      onChange({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  if (!value) return null;
  return (
    <Marker
      position={[value.lat, value.lng]}
      draggable
      eventHandlers={{
        dragend(e) {
          const ll = e.target.getLatLng();
          onChange({ lat: ll.lat, lng: ll.lng });
        },
      }}
    />
  );
}

function RecenterOnChange({
  center,
  hasPin,
  centerZoom,
  pinZoom,
}: {
  center: LatLng;
  hasPin: boolean;
  centerZoom: number;
  pinZoom: number;
}) {
  const map = useMap();
  useEffect(() => {
    map.flyTo([center.lat, center.lng], hasPin ? pinZoom : centerZoom, {
      duration: 0.6,
    });
  }, [center.lat, center.lng, hasPin, centerZoom, pinZoom, map]);
  return null;
}

export default function MeetingPointMap({
  value,
  center,
  centerZoom = 13,
  pinZoom = 16,
  onChange,
}: MeetingPointMapProps) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted">
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={value ? pinZoom : centerZoom}
        scrollWheelZoom
        zoomControl
        style={{ height: 380, width: "100%" }}
      >
        {/* CARTO Positron: light, minimal basemap. Free, attribution required. */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
          maxZoom={20}
        />
        <ClickAndDragLayer value={value} onChange={onChange} />
        <RecenterOnChange
          center={center}
          hasPin={Boolean(value)}
          centerZoom={centerZoom}
          pinZoom={pinZoom}
        />
      </MapContainer>
    </div>
  );
}
