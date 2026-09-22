declare global {
  namespace Express {
    interface Request {
      requestId: string;
      user?: {
        id: string;
        name: string;
        email: string;
        role: "admin" | "teacher" | "student";
        isActive: boolean;
        preferredLocale: "en" | "vi";
      };
    }
  }
}
export {}
