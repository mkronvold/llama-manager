import { formatMs } from "./utils";

export function taskNumber(value: number | null): string {
  return value === null ? "n/a" : value.toLocaleString();
}

export function taskRate(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} t/s`;
}

export function taskTime(value: number | null): string {
  return value === null ? "n/a" : formatMs(value);
}
