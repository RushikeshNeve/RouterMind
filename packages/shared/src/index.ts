import { z } from "zod";

export const nonEmptyStringSchema = z.string().trim().min(1);

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
