import { tokenPayload } from './tokenPayload.type.js';

declare module 'express' {
  interface Request {
    user?: any;
    decoded: tokenPayload;
  }
}
