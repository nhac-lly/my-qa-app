"use client";

import { RegistrationForm } from "@/components/registration-form";

export default function RegisterPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-2xl flex-col items-center justify-start py-16 px-4 sm:px-8 bg-white dark:bg-black">
        <div className="w-full max-w-md">
          <h1 className="text-4xl font-bold mb-2 text-black dark:text-zinc-50 text-center">
            Create Arobid Account
          </h1>
          <p className="text-lg text-zinc-600 dark:text-zinc-400 mb-8 text-center">
            Fill out the form below to create your account
          </p>
          <RegistrationForm />
          <div className="mt-4 text-center">
            <a
              href="/"
              className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline"
            >
              ← Go Back Home
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}

