import { GoogleGenAI } from '@google/genai';
import dedent from 'dedent';
import { KnownError } from './error';
import { streamToIterable } from './stream-to-iterable';
import { detectShell } from './os-detect';
import type { AxiosError } from 'axios';
import { streamToString } from './stream-to-string';
import './replace-all-polyfill';
import i18n from './i18n';
import { stripRegexPatterns } from './strip-regex-patterns';
import readline from 'readline';

const explainInSecondRequest = true;

function getGemini(key: string) {
  const genAI = new GoogleGenAI(key); // Fixed typo here
  return genAI;
}

// Gemini outputs markdown format for code blocks. It often uses
// a github style like: "```bash"
const shellCodeExclusions = [/```[a-zA-Z]*\n/gi, /```[a-zA-Z]*/gi, '\n'];

// Helper function to check if a model name is likely a Gemini model
function modellenNameIsGemini(modelName?: string): modelName is string {
  if (!modelName) return false;
  // Simple check: Gemini models usually don't start with 'gpt-' or 'text-'
  // and often include 'gemini'. This can be made more robust.
  return modelName.includes('gemini') || (!modelName.startsWith('gpt-') && !modelName.startsWith('text-'));
}

export async function getScriptAndInfo({
  prompt,
  key,
  modelName,
}: {
  prompt: string;
  key: string;
  modelName?: string;
}) {
  const currentModelName = modellenNameIsGemini(modelName) ? modelName : 'gemini-1.5-flash-latest';
  const fullPrompt = getFullPrompt(prompt);
  const stream = await generateCompletion({
    prompt: fullPrompt,
    number: 1,
    key,
    modelName: currentModelName,
  });
  // const iterableStream = streamToIterable(stream); // Removed for Gemini
  return {
    readScript: readData(stream, ...shellCodeExclusions), // Pass stream directly
    readInfo: readData(stream, ...shellCodeExclusions),   // Pass stream directly
  };
}

export async function generateCompletion({
  prompt,
  number = 1,
  key,
  modelName,
}: {
  prompt: string; // Simplified for now, will adjust if needed for chat history
  number?: number;
  modelName?: string;
  key: string;
}) {
  const genAI = getGemini(key);
  const currentModelName = modellenNameIsGemini(modelName) ? modelName : 'gemini-1.5-flash-latest';

  try {
    const result = await genAI.models.generateContentStream({ // Call on genAI.models
      model: currentModelName, // Use potentially overridden model name
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // generationConfig: { // Add if needed
      //   candidateCount: number,
      // },
    });

    // The 'result' from generateContentStream is already the AsyncGenerator
    return result; // Return the stream directly
  } catch (err) {
    const error = err as Error; // Adjust error handling as per Gemini SDK

    // TODO: Adapt error handling for Gemini
    // if (error.code === 'ENOTFOUND') {
    //   throw new KnownError(
    //     `Error connecting to ${error.request.hostname} (${error.request.syscall}). Are you connected to the internet?`
    //   );
    // }

    // const response = error.response;
    // let message = response?.data as string | object | IncomingMessage;
    // if (response && message instanceof IncomingMessage) {
    //   message = await streamToString(
    //     response.data as unknown as IncomingMessage
    //   );
    //   try {
    //     message = JSON.parse(message);
    //   } catch (e) {
    //     // Ignore
    //   }
    // }

    // const messageString = message && JSON.stringify(message, null, 2);
    // if (response?.status === 429) { // Adjust status codes for Gemini
    //   throw new KnownError(
    //     dedent`
    //     Request to Gemini API failed with status 429. This is due to incorrect billing setup or excessive quota usage.
    //     Full message from Gemini:
    //   ` +
    //       '\n\n' +
    //       messageString +
    //       '\n'
    //   );
    // } else if (response && message) {
    //   throw new KnownError(
    //     dedent`
    //     Request to Gemini API failed with status ${response?.status}:
    //   ` +
    //       '\n\n' +
    //       messageString +
    //       '\n'
    //   );
    // }
    throw new KnownError(`Gemini API Error: ${error.message}`);
  }
}

export async function getExplanation({
  script,
  key,
  modelName,
}: {
  script: string;
  key: string;
  modelName?: string;
}) {
  const prompt = getExplanationPrompt(script);
  const currentModelName = modellenNameIsGemini(modelName) ? modelName : 'gemini-1.5-flash-latest';
  const stream = await generateCompletion({
    prompt,
    key,
    number: 1,
    modelName: currentModelName,
  });
  // const iterableStream = streamToIterable(stream); // Removed for Gemini
  return { readExplanation: readData(stream) }; // Pass stream directly
}

export async function getRevision({
  prompt,
  code,
  key,
  modelName,
}: {
  prompt: string;
  code: string;
  key: string;
  modelName?: string;
}) {
  const fullPrompt = getRevisionPrompt(prompt, code);
  const currentModelName = modellenNameIsGemini(modelName) ? modelName : 'gemini-1.5-flash-latest';
  const stream = await generateCompletion({
    prompt: fullPrompt,
    key,
    number: 1,
    modelName: currentModelName,
  });
  // const iterableStream = streamToIterable(stream); // Removed for Gemini
  return {
    readScript: readData(stream, ...shellCodeExclusions), // Pass stream directly
  };
}

export const readData =
  (
    iterableStream: AsyncGenerator<any, void>, // Adjusted type for Gemini stream
    ...excluded: (RegExp | string | undefined)[]
  ) =>
  (writer: (data: string) => void): Promise<string> =>
    new Promise(async (resolve) => {
      let stopTextStream = false;
      let data = '';
      let content = '';
      let dataStart = false;
      let buffer = '';

      const [excludedPrefix] = excluded;
      const stopTextStreamKeys = ['q', 'escape'];

      const rl = readline.createInterface({
        input: process.stdin,
      });

      process.stdin.setRawMode(true);

      process.stdin.on('keypress', (key, data) => {
        if (stopTextStreamKeys.includes(data.name)) {
          stopTextStream = true;
        }
      });

      for await (const chunk of iterableStream) {
        // Adapt chunk processing for Gemini's stream format
        // const payloads = chunk.toString().split('\n\n');
        // For Gemini, the chunk might be structured differently, e.g., chunk.text()
        const textContent = chunk.text(); // Assuming chunk has a text() method

        if (stopTextStream) {
          dataStart = false;
          resolve(data);
          return;
        }

        // Simulate OpenAI's data structure for now
        // This needs to be adapted based on actual Gemini stream structure
        // if (payload.startsWith('data:')) { // This check might not be relevant for Gemini

        content = textContent;
        if (!dataStart) {
          buffer += content;
          if (buffer.match(excludedPrefix ?? '')) {
            dataStart = true;
            buffer = '';
            if (excludedPrefix) continue; // continue instead of break to process the rest of the chunk
          }
        }

        if (dataStart && content) {
          const contentWithoutExcluded = stripRegexPatterns(
            content,
            excluded
          );

          data += contentWithoutExcluded;
          writer(contentWithoutExcluded);
        }
        // }
      }
      resolve(data);
    });

function getExplanationPrompt(script: string) {
  return dedent`
    ${explainScript} Please reply in ${i18n.getCurrentLanguagenName()}

    The script: ${script}
  `;
}

function getShellDetails() {
  const shellDetails = detectShell();

  return dedent`
      The target shell is ${shellDetails}
  `;
}
const shellDetails = getShellDetails();

const explainScript = dedent`
  Please provide a clear, concise description of the script, using minimal words. Outline the steps in a list format.
`;

function getOperationSystemDetails() {
  const os = require('@nexssp/os/legacy');
  return os.name();
}
const generationDetails = dedent`
    Only reply with the single line command surrounded by three backticks. It must be able to be directly run in the target shell. Do not include any other text.

    Make sure the command runs on ${getOperationSystemDetails()} operating system.
  `;

function getFullPrompt(prompt: string) {
  return dedent`
    Create a single line command that one can enter in a terminal and run, based on what is specified in the prompt.

    ${shellDetails}

    ${generationDetails}

    ${explainInSecondRequest ? '' : explainScript}

    The prompt is: ${prompt}
  `;
}

function getRevisionPrompt(prompt: string, code: string) {
  return dedent`
    Update the following script based on what is asked in the following prompt.

    The script: ${code}

    The prompt: ${prompt}

    ${generationDetails}
  `;
}

// TODO: Implement getModels for Gemini if needed, or remove if not applicable
// export async function getModels(
//   key: string,
// ): Promise<any[]> { // Adjust return type
//   const genAI = getGemini(key);
//   // Gemini SDK might have a different way to list models or this might not be needed
//   return [];
// }
