import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// Dependency-free SVG charts for the dashboard. Colors are passed in by role;
// text always uses ink colors, never the series color.

export const INK = {
  primary: "#0b0b0b",
  secondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  baseline: "#c3c2b7",
  surface: "#ffffff",
};

export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  critical: "#d03b3b",
};

export const SERIES_BLUE = "#2a78d6";

const pct = (value: number, total: number) =>
  total > 0 ? `${Math.round((value / total) * 1000) / 10}%` : "0%";

const tooltipStyle: CSSProperties = {
  position: "absolute",
  pointerEvents: "none",
  background: INK.primary,
  color: "#fff",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 12,
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  transform: "translate(-50%, calc(-100% - 8px))",
  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
  zIndex: 1,
};

export type Segment = { label: string; value: number; color: string; hint?: string };

/** Donut for part-to-whole (<= 4 segments). Legend doubles as the data table. */
export function Donut({
  segments,
  centerLabel,
  size = 180,
}: {
  segments: Segment[];
  centerLabel: string;
  size?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const stroke = 26;
  const radius = (size - stroke) / 2 - 4;
  const circumference = 2 * Math.PI * radius;
  const visible = segments.filter((s) => s.value > 0).length;
  const gap = visible > 1 ? 2 : 0; // 2px surface gap between segments

  const lengths = segments.map((s) => (total > 0 ? (s.value / total) * circumference : 0));
  const arcs = segments.map((segment, index) => ({
    segment,
    index,
    length: lengths[index],
    offset: lengths.slice(0, index).reduce((sum, l) => sum + l, 0),
  }));

  const shown = active !== null ? segments[active] : null;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 24 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(", ")}
        style={{ flex: "none" }}
      >
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={INK.grid}
            strokeWidth={stroke}
          />
          {arcs.map(({ segment, index, length, offset: start }) =>
            length > 0 ? (
              <circle
                key={segment.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth={active === index ? stroke + 6 : stroke}
                strokeDasharray={`${Math.max(length - gap, 0.5)} ${circumference}`}
                strokeDashoffset={-start}
                opacity={active === null || active === index ? 1 : 0.35}
                style={{ transition: "opacity 120ms, stroke-width 120ms", cursor: "pointer" }}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
              >
                <title>{`${segment.label}: ${segment.value} (${pct(segment.value, total)})`}</title>
              </circle>
            ) : null,
          )}
        </g>
        <text
          x="50%"
          y="47%"
          textAnchor="middle"
          fontSize={shown ? 24 : 28}
          fontWeight={600}
          fill={INK.primary}
        >
          {shown ? pct(shown.value, total) : total.toLocaleString()}
        </text>
        <text x="50%" y="60%" textAnchor="middle" fontSize={12} fill={INK.secondary}>
          {shown ? shown.label : centerLabel}
        </text>
      </svg>

      <ul style={{ listStyle: "none", margin: 0, padding: 0, flex: "1 1 160px", minWidth: 160 }}>
        {segments.map((segment, index) => (
          <li
            key={segment.label}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
            style={{
              display: "grid",
              gridTemplateColumns: "12px 1fr auto",
              alignItems: "center",
              columnGap: 10,
              padding: "8px 6px",
              borderRadius: 8,
              background: active === index ? "rgba(11,11,11,0.04)" : "transparent",
              cursor: "default",
            }}
          >
            <span
              aria-hidden
              style={{ width: 12, height: 12, borderRadius: 3, background: segment.color }}
            />
            <span style={{ color: INK.primary, fontSize: 13 }}>
              {segment.label}
              {segment.hint && (
                <span style={{ display: "block", color: INK.muted, fontSize: 12 }}>
                  {segment.hint}
                </span>
              )}
            </span>
            <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              <span style={{ color: INK.primary, fontSize: 13, fontWeight: 600 }}>
                {segment.value.toLocaleString()}
              </span>
              <span style={{ display: "block", color: INK.muted, fontSize: 12 }}>
                {pct(segment.value, total)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type Bar = { label: string; value: number; detail?: string };

/** Vertical bars for an ordered set of buckets (single series, one color). */
export function ColumnChart({
  bars,
  color = SERIES_BLUE,
  height = 200,
  valueSuffix = "",
}: {
  bars: Bar[];
  color?: string;
  height?: number;
  valueSuffix?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.value));
  const width = 520;
  const top = 22;
  const bottom = 28;
  const plotHeight = height - top - bottom;
  const slot = width / bars.length;
  const barWidth = Math.min(56, slot * 0.6);
  const ticks = [0, 0.5, 1].map((t) => Math.round(max * t));

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={bars.map((b) => `${b.label}: ${b.value}`).join(", ")}
        style={{ display: "block", overflow: "visible" }}
      >
        {ticks.map((tick) => {
          const y = top + plotHeight - (tick / max) * plotHeight;
          return (
            <g key={tick}>
              <line
                x1={0}
                x2={width}
                y1={y}
                y2={y}
                stroke={tick === 0 ? INK.baseline : INK.grid}
                strokeWidth={1}
              />
            </g>
          );
        })}
        {bars.map((bar, index) => {
          const barHeight = (bar.value / max) * plotHeight;
          const x = index * slot + (slot - barWidth) / 2;
          const y = top + plotHeight - barHeight;
          const r = Math.min(4, barHeight);
          return (
            <g
              key={bar.label}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              style={{ cursor: "pointer" }}
            >
              {/* Hit target bigger than the mark */}
              <rect x={index * slot} y={top} width={slot} height={plotHeight} fill="transparent" />
              {barHeight > 0 && (
                <path
                  d={`M${x},${y + barHeight} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${y + barHeight} Z`}
                  fill={color}
                  opacity={active === null || active === index ? 1 : 0.45}
                />
              )}
              <text
                x={x + barWidth / 2}
                y={y - 6}
                textAnchor="middle"
                fontSize={12}
                fontWeight={600}
                fill={INK.secondary}
              >
                {bar.value.toLocaleString()}
              </text>
              <text
                x={index * slot + slot / 2}
                y={height - 8}
                textAnchor="middle"
                fontSize={12}
                fill={INK.muted}
              >
                {bar.label}
              </text>
            </g>
          );
        })}
      </svg>
      {active !== null && (
        <div
          style={{
            ...tooltipStyle,
            left: `${((active + 0.5) / bars.length) * 100}%`,
            top: `${(top / height) * 100}%`,
          }}
        >
          <strong>{bars[active].label}</strong>
          <br />
          {bars[active].value.toLocaleString()}
          {valueSuffix}
          {bars[active].detail ? ` · ${bars[active].detail}` : ""}
        </div>
      )}
    </div>
  );
}

/** Horizontal ranked bars (single series). `renderLabel` can return a link. */
export function BarList({
  bars,
  color = SERIES_BLUE,
  renderLabel,
  valueSuffix = "",
}: {
  bars: Bar[];
  color?: string;
  renderLabel?: (bar: Bar, index: number) => ReactNode;
  valueSuffix?: string;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {bars.map((bar, index) => (
        <div key={`${bar.label}-${index}`} title={`${bar.label}: ${bar.value}${valueSuffix}`}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              fontSize: 13,
              marginBottom: 4,
            }}
          >
            <span
              style={{
                color: INK.primary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {renderLabel ? renderLabel(bar, index) : bar.label}
            </span>
            <span
              style={{
                color: INK.secondary,
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                flex: "none",
              }}
            >
              {bar.value.toLocaleString()}
              {valueSuffix}
            </span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: INK.grid }}>
            <div
              style={{
                width: `${Math.max(2, (bar.value / max) * 100)}%`,
                height: "100%",
                borderRadius: 4,
                background: color,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Headline number tile. */
export function StatTile({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string;
  detail?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: INK.surface,
        borderRadius: 12,
        padding: "16px 18px",
        boxShadow: "0 0 0 1px rgba(11,11,11,0.08), 0 1px 2px rgba(11,11,11,0.06)",
        display: "grid",
        gap: 4,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK.secondary }}>
        {accent && (
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: accent }} />
        )}
        {label}
      </span>
      <span style={{ fontSize: 28, fontWeight: 650, color: INK.primary, lineHeight: 1.15 }}>
        {value}
      </span>
      {detail && <span style={{ fontSize: 12, color: INK.muted }}>{detail}</span>}
    </div>
  );
}
