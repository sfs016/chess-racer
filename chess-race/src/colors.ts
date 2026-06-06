// Stable per-racer colours, keyed off a racer's fixed colorIndex.

export const LANE_COLORS = [
  "#6ea8ff",
  "#56d68a",
  "#ff8f6b",
  "#c98bff",
  "#ffd166",
  "#4dd0e1",
  "#f06292",
  "#a3e635",
  "#ff6b6b",
  "#9b7bff",
];

export const COLOR_NAMES = [
  "blue",
  "green",
  "orange",
  "purple",
  "gold",
  "cyan",
  "pink",
  "lime",
  "red",
  "violet",
];

export const colorFor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
export const colorName = (i: number) => COLOR_NAMES[i % COLOR_NAMES.length];
