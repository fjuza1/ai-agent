import { login, register } from "../actions";

export function generateMetadata() {
  return { title: "Sign in | Sticker Vault", description: "Sign in to manage your sticker collection.", robots: { index: false, follow: false } };
}
export default function Login() {
  return <div className="grid md:grid-cols-2 gap-8"><section><h1 className="text-3xl font-bold">Sign in</h1><form action={login} className="grid gap-3 mt-4"><label>Email <input className="block w-full" type="email" name="email" required /></label><label>Password <input className="block w-full" type="password" name="password" minLength={12} maxLength={128} required /></label><button>Sign in</button></form></section><section><h2 className="text-3xl font-bold">Create account</h2><form action={register} className="grid gap-3 mt-4"><label>Email <input className="block w-full" type="email" name="email" required /></label><label>Password (12+ characters) <input className="block w-full" type="password" name="password" minLength={12} maxLength={128} required /></label><button>Create account</button></form></section></div>;
}
