import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type Point = {
  lat: number;
  lng: number;
  label?: string;
  popup?: string;
  statusKind?: 'active' | 'recent' | 'stale' | 'unknown';
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
      const statusKind = point.statusKind ?? 'unknown';
      const marker = L.marker([point.lat, point.lng], {
        icon: L.divIcon({
          className: `admin-map-marker admin-map-marker--${statusKind}`,
          html: '<span></span>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
          popupAnchor: [0, -10],
        }),
      });
      marker.bindTooltip(point.label ?? '位置', {
        direction: 'top',
        offset: [0, -10],
        opacity: 0.94,
      });
      marker.bindPopup(point.popup ?? point.label ?? '位置');
      marker.addTo(layers);
      bounds.push([point.lat, point.lng]);
    }

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [24, 24] });
    }
  }, [props.center, props.markers, props.route]);

  return (
    <div
      className="admin-map"
      ref={hostRef}
      style={{
        width: '100%',
        height: props.height ?? 280,
      }}
    />
  );
}
