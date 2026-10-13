// Scratch's Translate block asks translate-service.scratch.mit.edu, which only
// answers scratch.mit.edu. Its requests go to CodeyKids instead, with the AI
// token the page hands over. With no token, or when CodeyKids can't answer,
// the request fails and the block gives back the words it was given, as it
// does on Scratch when the service is down.
const SERVICE = "https://translate-service.scratch.mit.edu/translate?";
const TRANSLATE = "mutation($input: AiTranslateInput!) { aiTranslate(input: $input) }";

type Access = { token: string; url: string };

let access: Access | undefined;

export const setTranslateAccess = (value: Access) => {
  access = value;
};

const translate = async (fetchFrom: typeof fetch, url: URL) => {
  if (!access) throw new Error("The page has not handed over an AI token");

  const response = await fetchFrom(access.url, {
    body: JSON.stringify({
      query: TRANSLATE,
      variables: {
        input: {
          language: url.searchParams.get("language") ?? "",
          text: url.searchParams.get("text") ?? "",
          token: access.token,
        },
      },
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const { data } = await response.json();

  if (typeof data?.aiTranslate !== "string") throw new Error("CodeyKids did not translate");

  return new Response(JSON.stringify({ result: data.aiTranslate }), {
    headers: { "Content-Type": "application/json" },
  });
};

// Wraps the page's fetch once, before the VM can ask for anything.
export const routeTranslations = () => {
  const fetchFrom = window.fetch.bind(window);

  window.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    return url.startsWith(SERVICE) ? translate(fetchFrom, new URL(url)) : fetchFrom(input, init);
  };
};
