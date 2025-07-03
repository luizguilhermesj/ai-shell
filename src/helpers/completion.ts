import {
  OpenAIApi,
  Configuration,
  ChatCompletionRequestMessage,
} from 'openai';
import dedent from 'dedent';
import { IncomingMessage } from 'http';
import { KnownError } from './error';
import { streamToIterable } from './stream-to-iterable';
import { detectShell } from './os-detect';
import type { AxiosError } from 'axios';
import { streamToString } from './stream-to-string';
import './replace-all-polyfill';
import i18n from './i18n';
import { stripRegexPatterns } from './strip-regex-patterns';
import readline from 'readline';
import { getConfig } from './config';
import * as gemini from './gemini-completion';

const explainInSecondRequest = true;

function getOpenAi(key: string, apiEndpoint: string) {
  const openAi = new OpenAIApi(
    new Configuration({ apiKey: key, basePath: apiEndpoint })
  );
  return openAi;
}

// Openai outputs markdown format for code blocks. It oftne uses
// a github style like: "```bash"
const shellCodeExclusions = [/```[a-zA-Z]*\n/gi, /```[a-zA-Z]*/gi, '\n'];

export async function getScriptAndInfo({
  prompt,
  key, // This will be OPENAI_KEY or GEMINI_API_KEY based on provider
  model,
  apiEndpoint, // Only for OpenAI
}: {
  prompt: string;
  key: string;
  model?: string;
  apiEndpoint: string; // Keep for OpenAI, Gemini might not need a separate endpoint config
}) {
  const config = await getConfig();
  const fullPrompt = getFullPrompt(prompt);
  // console.log("DEBUG: getScriptAndInfo - AI_PROVIDER:", config.AI_PROVIDER, "GEMINI_API_KEY:", config.GEMINI_API_KEY ? "SET" : "NOT SET");

  if (config.AI_PROVIDER === 'gemini') {
    if (!config.GEMINI_API_KEY) {
      throw new KnownError(
        'Gemini API key is not set. Please run `ai-shell config set GEMINI_API_KEY <your-key>`'
      );
    }
    // @ts-expect-error
    return gemini.getScriptAndInfo({ prompt: fullPrompt, key: config.GEMINI_API_KEY, modelName: model });
  }

  // Default to OpenAI
  if (!config.OPENAI_KEY) {
    throw new KnownError(
      'OpenAI API key is not set. Please run `ai-shell config set OPENAI_KEY <your-key>`'
    );
  }
  const stream = await generateCompletion({
    prompt: fullPrompt,
    number: 1,
    key: config.OPENAI_KEY,
    model,
    apiEndpoint: config.OPENAI_API_ENDPOINT,
  });
  const iterableStream = streamToIterable(stream);
  return {
    readScript: readData(iterableStream, ...shellCodeExclusions),
    readInfo: readData(iterableStream, ...shellCodeExclusions),
  };
}

export async function generateCompletion({
  prompt,
  number = 1,
  key,
  model,
  apiEndpoint,
}: {
  prompt: string | ChatCompletionRequestMessage[];
  number?: number;
  model?: string;
  key: string;
  apiEndpoint: string;
}) {
  const config = await getConfig();
  // console.log("DEBUG: generateCompletion - AI_PROVIDER:", config.AI_PROVIDER, "GEMINI_API_KEY:", config.GEMINI_API_KEY ? "SET" : "NOT SET");

  if (config.AI_PROVIDER === 'gemini') {
    if (!config.GEMINI_API_KEY) {
      throw new KnownError('Gemini API key not set.');
    }
    // @ts-expect-error
    return gemini.generateCompletion({ prompt: prompt as string, number, key: config.GEMINI_API_KEY, modelName: model });
  }

  // Default to OpenAI
  if (!config.OPENAI_KEY) {
    throw new KnownError('OpenAI API key not set.');
  }
  const openAi = getOpenAi(config.OPENAI_KEY, apiEndpoint);
  try {
    const completion = await openAi.createChatCompletion(
      {
        model: model || 'gpt-4o-mini',
        messages: Array.isArray(prompt)
          ? prompt
          : [{ role: 'user', content: prompt }],
        n: Math.min(number, 10),
        stream: true,
      },
      { responseType: 'stream' }
    );

    return completion.data as unknown as IncomingMessage;
  } catch (err) {
    const error = err as AxiosError;

    if (error.code === 'ENOTFOUND') {
      throw new KnownError(
        `Error connecting to ${error.request.hostname} (${error.request.syscall}). Are you connected to the internet?`
      );
    }

    const response = error.response;
    let message = response?.data as string | object | IncomingMessage;
    if (response && message instanceof IncomingMessage) {
      message = await streamToString(
        response.data as unknown as IncomingMessage
      );
      try {
        message = JSON.parse(message);
      } catch (e) {
        // Ignore
      }
    }

    const messageString = message && JSON.stringify(message, null, 2);
    if (response?.status === 429) {
      throw new KnownError(
        dedent`
        Request to OpenAI failed with status 429. This is due to incorrect billing setup or excessive quota usage. Please follow this guide to fix it: https://help.openai.com/en/articles/6891831-error-code-429-you-exceeded-your-current-quota-please-check-your-plan-and-billing-details

        You can activate billing here: https://platform.openai.com/account/billing/overview . Make sure to add a payment method if not under an active grant from OpenAI.

        Full message from OpenAI:
      ` +
          '\n\n' +
          messageString +
          '\n'
      );
    } else if (response && message) {
      throw new KnownError(
        dedent`
        Request to OpenAI failed with status ${response?.status}:
      ` +
          '\n\n' +
          messageString +
          '\n'
      );
    }

    throw error;
  }
}

export async function getExplanation({
  script,
  key,
  model,
  apiEndpoint,
}: {
  script: string;
  key: string;
  model?: string;
  apiEndpoint: string;
}) {
  const config = await getConfig();
  const prompt = getExplanationPrompt(script);
  // console.log("DEBUG: getExplanation - AI_PROVIDER:", config.AI_PROVIDER, "GEMINI_API_KEY:", config.GEMINI_API_KEY ? "SET" : "NOT SET");

  if (config.AI_PROVIDER === 'gemini') {
    if (!config.GEMINI_API_KEY) {
      throw new KnownError('Gemini API key not set.');
    }
    // @ts-expect-error
    return gemini.getExplanation({ script, key: config.GEMINI_API_KEY, modelName: model });
  }

  if (!config.OPENAI_KEY) {
    throw new KnownError('OpenAI API key not set.');
  }
  const stream = await generateCompletion({
    prompt,
    key: config.OPENAI_KEY,
    number: 1,
    model,
    apiEndpoint: config.OPENAI_API_ENDPOINT,
  });
  const iterableStream = streamToIterable(stream);
  return { readExplanation: readData(iterableStream) };
}

export async function getRevision({
  prompt,
  code,
  key,
  model,
  apiEndpoint,
}: {
  prompt: string;
  code: string;
  key: string;
  model?: string;
  apiEndpoint: string;
}) {
  const config = await getConfig();
  const fullPrompt = getRevisionPrompt(prompt, code);
  // console.log("DEBUG: getRevision - AI_PROVIDER:", config.AI_PROVIDER, "GEMINI_API_KEY:", config.GEMINI_API_KEY ? "SET" : "NOT SET");

  if (config.AI_PROVIDER === 'gemini') {
    if (!config.GEMINI_API_KEY) {
      throw new KnownError('Gemini API key not set.');
    }
    // @ts-expect-error
    return gemini.getRevision({ prompt, code, key: config.GEMINI_API_KEY, modelName: model });
  }

  if (!config.OPENAI_KEY) {
    throw new KnownError('OpenAI API key not set.');
  }
  const stream = await generateCompletion({
    prompt: fullPrompt,
    key: config.OPENAI_KEY,
    number: 1,
    model,
    apiEndpoint: config.OPENAI_API_ENDPOINT,
  });
  const iterableStream = streamToIterable(stream);
  return {
    readScript: readData(iterableStream, ...shellCodeExclusions),
  };
}

export const readData =
  (
    iterableStream: AsyncGenerator<any, void>, // Adjusted to 'any' for Gemini flexibility
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

      const config = await getConfig();

      for await (const chunk of iterableStream) {
        if (config.AI_PROVIDER === 'gemini') {
          // Handle Gemini stream chunk
           if (chunk && typeof chunk.text === 'function') {
            content = chunk.text();
          } else {
            // Fallback or error if structure is not as expected
            content = '';
          }
          if (stopTextStream) {
            dataStart = false;
            resolve(data);
            return;
          }

          if (!dataStart) {
            buffer += content;
            if (buffer.match(excludedPrefix ?? '')) {
              dataStart = true;
              buffer = '';
              if (excludedPrefix) continue;
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
        } else {
          // Handle OpenAI stream chunk
          const payloads = chunk.toString().split('\n\n');
          for (const payload of payloads) {
            if (payload.includes('[DONE]') || stopTextStream) {
              dataStart = false;
              resolve(data);
              return;
            }

            if (payload.startsWith('data:')) {
              content = parseOpenAIChoiceContent(payload);
              if (!dataStart) {
                buffer += content;
                if (buffer.match(excludedPrefix ?? '')) {
                  dataStart = true;
                  buffer = '';
                  if (excludedPrefix) break;
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
            }
          }
        }
      }
      resolve(data);
    });

function parseOpenAIChoiceContent(payload: string): string {
  const data = payload.replaceAll(/(\n)?^data:\s*/g, '');
  try {
    const delta = JSON.parse(data.trim());
    return delta.choices?.[0]?.delta?.content ?? '';
  } catch (error) {
    return `Error with JSON.parse and ${payload}.\n${error}`;
  }
}

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

