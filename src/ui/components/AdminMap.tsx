import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type Point = {
  lat: number;
  lng: number;
  label?: string;
};

export default function AdminMap(props: {
  center?: Point | null;
  markers?: Point[];
  route?: Point[];
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView([35.681236, 139.767125], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    layersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layers = layersRef.current;
    if (!map || !layers) return;

    layers.clearLayers();
    const bounds: L.LatLngTuple[] = [];

    if (props.route && props.route.length > 1) {
      const line = L.polyline(
        props.route.map(point => [point.lat, point.lng] as L.LatLngTuple),
        {
          color: '#38bdf8',
          weight: 4,
          opacity: 0.8,
        },
      );
      line.addTo(layers);
      bounds.push(...props.route.map(point => [point.lat, point.lng] as L.LatLngTuple));
    }

    const markers = props.markers ?? (props.center ? [props.center] : []);
    for (const point of markers) {
      L.marker([point.lat, point.lng]).bindPopup(point.label ?? '位置').addTo(layers);
      bounds.push([point.lat, point.lng]);
    }

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [24, 24] });
    }
  }, [props.center, props.markers, props.route]);

  return (
    <div
      ref={hostRef}
      style={{
        width: '100%',
        height: props.height ?? 280,
        borderRadius: 18,
        overflow: 'hidden',
        border: '1px solid rgba(148, 163, 184, 0.22)',
      }}
    />
  );
}
