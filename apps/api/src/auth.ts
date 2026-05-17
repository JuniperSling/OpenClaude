import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { User } from "@openclaude/shared";
import { config } from "./config.js";
import type { FileStore } from "./store.js";

type JwtPayload = {
  sub: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function signToken(user: User) {
  return jwt.sign({ sub: user.id } satisfies JwtPayload, config.jwtSecret, { expiresIn: "7d" });
}

export function authenticate(store: FileStore) {
  return (request: Request, response: Response, next: NextFunction) => {
    const header = request.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      response.status(401).json({ error: "Missing bearer token" });
      return;
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
      const user = store.getUserById(payload.sub);
      if (!user) {
        response.status(401).json({ error: "Unknown user" });
        return;
      }
      request.user = user;
      next();
    } catch {
      response.status(401).json({ error: "Invalid token" });
    }
  };
}

export function authenticateToken(store: FileStore, token: string | undefined): User | undefined {
  if (!token) return undefined;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    return store.getUserById(payload.sub);
  } catch {
    return undefined;
  }
}
