/**
 * Creates an account from the command line (connects as the owner role).
 * Use it once to create the first superadmin; after that, superadmins add users
 * from the dashboard's Users page.
 *
 *   npm run user:create -- --email you@example.com --superadmin [--name "Your Name"]
 *
 * The password is read from USER_PASSWORD, or prompted for (hidden) when unset.
 */
import readline from "node:readline";
import bcrypt from "bcryptjs";
import { credentialsSchema } from "../validation";
import { createPool, withTransaction } from "./index";
import { connectionString } from "./pools";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s) => {
    if (!muted || s.includes("\n")) out.output.write(muted ? "\n" : s);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  const email = arg("email");
  const superadmin = process.argv.includes("--superadmin");
  const displayName = arg("name") ?? null;
  if (!email) throw new Error("Usage: npm run user:create -- --email you@example.com [--superadmin] [--name \"Name\"]");

  const password = process.env.USER_PASSWORD ?? (await promptHidden(`Password for ${email}: `));
  const parsed = credentialsSchema.safeParse({ email, password });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid email or password");

  const hash = await bcrypt.hash(parsed.data.password, 12);
  const pool = createPool({ connectionString: connectionString(), max: 1, applicationName: "claude-sre-create-user" });
  try {
    const id = await withTransaction(pool, async (c) => {
      const { rows } = await c.query<{ id: string }>("select app.sign_up($1, $2, $3) as id", [
        parsed.data.email,
        hash,
        displayName,
      ]);
      const newId = rows[0]!.id;
      if (superadmin) await c.query("update public.users set is_superadmin = true where id = $1", [newId]);
      return newId;
    });
    console.log(`created ${parsed.data.email}${superadmin ? " (superadmin)" : ""}: ${id}`);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new Error("An account with this email already exists");
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
