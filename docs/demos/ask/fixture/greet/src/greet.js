const HELLO = { en: "Hello", es: "Hola", fr: "Bonjour", pt: "Olá", hi: "Namaste" };

export function greet(name, { lang = "en", loud = false } = {}) {
  const s = `${HELLO[lang] ?? HELLO.en}, ${name}!`;
  return loud ? s.toUpperCase() : s;
}
