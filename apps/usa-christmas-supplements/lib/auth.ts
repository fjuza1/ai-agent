import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import SendGrid from "next-auth/providers/sendgrid";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import sgMail from "@sendgrid/mail";
import { db } from "./db";

declare module "next-auth" {
  interface Session { user: { id: string } & DefaultSession["user"] }
}

export const normalizeEmail = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");
export const hashPassword = (password: string) => bcrypt.hash(password, 12);

let timingHash: Promise<string> | undefined;

const adapter = PrismaAdapter(db as never);
const baseUpdateUser = adapter.updateUser!;
// Proving inbox ownership (magic link) on an account that was created with a password before the email was verified
// drops that password, so someone who pre-registered another person's address cannot keep access to it.
adapter.updateUser = async (data) => {
  // Single guarded statement: no read-then-write window between the check and the password drop.
  if (data.emailVerified) await db.user.updateMany({ where: { id: data.id, emailVerified: null, passwordHash: { not: null } }, data: { passwordHash: null } });
  return baseUpdateUser(data);
};

const magicLink = process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL
  ? [SendGrid({
      apiKey: process.env.SENDGRID_API_KEY,
      from: process.env.SENDGRID_FROM_EMAIL,
      maxAge: 15 * 60,
      async sendVerificationRequest({ identifier, url, provider }) {
        const host = new URL(url).host;
        sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
        await sgMail.send({
          to: identifier, from: provider.from!, subject: `Sign in to Winterwell USA`,
          text: `Sign in to ${host}:\n${url}\n\nThe link expires in 15 minutes. If you did not request it, ignore this email.`,
          html: `<p>Sign in to <strong>${host}</strong>:</p><p><a href="${url}">Sign in to Winterwell USA</a></p><p>The link expires in 15 minutes. If you did not request it, ignore this email.</p>`,
          trackingSettings: { clickTracking: { enable: false, enableText: false }, openTracking: { enable: false } },
          ...(process.env.SENDGRID_IP_POOL ? { ipPoolName: process.env.SENDGRID_IP_POOL } : {}),
        });
      },
    })]
  : [];

export const magicLinkEnabled = magicLink.length > 0;

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter,
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/login", verifyRequest: "/login?sent=1", error: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        const email = normalizeEmail(credentials?.email);
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!email || !password || password.length > 128) return null;
        const user = await db.user.findUnique({ where: { email } });
        // Always run a bcrypt comparison so unknown emails cost the same as wrong passwords.
        timingHash ??= bcrypt.hash("timing-equalizer", 12);
        const matches = await bcrypt.compare(password, user?.passwordHash ?? await timingHash);
        return user?.passwordHash && matches ? { id: user.id, email: user.email, name: user.name } : null;
      },
    }),
    ...magicLink,
  ],
  callbacks: {
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
