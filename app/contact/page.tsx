export default function ContactPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-center py-32 px-16 bg-white dark:bg-black">
        <h1 className="text-4xl font-bold mb-4 text-black dark:text-zinc-50">Contact</h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400 mb-8">
          This is the contact page. You navigated here using chat!
        </p>
        <a
          href="/"
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Go Back Home
        </a>
      </main>
    </div>
  );
}

