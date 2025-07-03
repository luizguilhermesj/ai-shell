import { Model, OpenAIApi, Configuration } from 'openai';
import { KnownError } from './error';
// import { getConfig } from './config'; // Removed to break cycle

async function getOpenAi(key: string, apiEndpoint: string) {
  const openAi = new OpenAIApi(
    new Configuration({ apiKey: key, basePath: apiEndpoint })
  );
  return openAi;
}

export async function getModels(
  aiProvider: string,
  openAIKey?: string,
  openAIEndpoint?: string
  // geminiKey?: string // Add if needed for Gemini model listing in future
): Promise<Model[]> { // This return type is OpenAI specific
  // const config = await getConfig(); // Removed

  if (aiProvider === 'gemini') {
    // TODO: Implement model listing for Gemini if their SDK supports it and it's needed.
    // For now, returning an empty array or a predefined list for Gemini.
    // This function is currently only used for OpenAI model selection in config UI.
    return [];
  }

  // Default to OpenAI
  if (!openAIKey) {
    throw new KnownError('OpenAI API key not set.');
  }
  if (!openAIEndpoint) {
    throw new KnownError('OpenAI API endpoint not set.');
  }
  const openAi = getOpenAi(openAIKey, openAIEndpoint);
  const response = await openAi.listModels();

  return response.data.data.filter((model) => model.object === 'model');
}
