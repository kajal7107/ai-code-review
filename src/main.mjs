import { readFileSync } from "fs";
import * as core from "@actions/core";
import { OpenAIClient, AzureKeyCredential } from "@azure/openai";
import { Octokit } from "@octokit/rest";
import parseDiff from "parse-diff";
import minimatch from "minimatch";
import express from "express";
import { createServer } from "node:http";
import pkg from 'eventsource';
const  EventSource  = pkg;
import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import { createTokenAuth } from "@octokit/auth-token";

const GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL = core.getInput("OPENAI_API_MODEL");
const GITHUB_EVENT_PATH= core.getInput("GITHUB_EVENT_PATH");

const auth = createTokenAuth(process.env.GITHUB_TOKEN);
const { token } = await auth();
console.log(token, "token");


const octokit = new Octokit({ 
  //auth: GITHUB_TOKEN 
  auth: token
});
const webhooks = new Webhooks({
  secret: "9c7beb8a-95ce-4509-9263-405965c68e43",
});

webhooks.onAny(({ id, name, payload }) => {
  console.log(name, "event received");
});

createServer(createNodeMiddleware(webhooks)).listen(8080);

const webhookProxyUrl = "https://smee.io/CrtUa0Qts3BR9Ca"; // replace with your own Webhook Proxy URL
const source = new EventSource(webhookProxyUrl);
source.onmessage = (event) => {
  const webhookEvent = JSON.parse(event.data);
  console.log("Received webhook event:", webhookEvent["x-github-event"])
  webhooks.receive({
     id: webhookEvent["x-request-id"],
    name: webhookEvent["x-github-event"],
    payload: webhookEvent.body,
  })
  .then(console.log)
  
    // .verifyAndReceive({
    //   id: webhookEvent["x-request-id"],
    //   name: webhookEvent["x-github-event"],
    //  // signature: webhookEvent["x-hub-signature"],
    //   payload: JSON.stringify(webhookEvent.body),
    // })
    .catch(console.error);
};

const openai = new OpenAIClient("https://reviewer-ai.openai.azure.com/", new AzureKeyCredential("6c3f4acf90a54a62a948250a67fc5f91"));

const app = express();
const port = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP' });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

async function getPRDetails(payload) {
  // const { repository, number } = JSON.parse(
  //   payload
  //  //readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  //  // readFileSync(GITHUB_EVENT_PATH||"", "utf8")
  // );
  const repository=payload.repository;
  const number=payload.number;
  // const prResponse = await octokit.pulls.get({
  //   owner: repository.owner.login,
  //   repo: repository.name,
  //   pull_number: number,
  // });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    //title: prResponse.data.title ?? "",
   // description: prResponse.data.body ?? "",
   title:payload.pull_request.title,
    description:payload.pull_request.body,
  };
}

async function getDiff(owner, repo, pull_number) {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  return response.data; // response.data is a string
}

async function analyzeCode(parsedDiff, prDetails) {
  const comments = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file, chunk, prDetails) {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${file.to}" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt) {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.getChatCompletions(
      "reviewer-ai",
      [{ role: "system", content: prompt }],
    );

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(file, chunk, aiResponses) {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(owner, repo, pull_number, comments) {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main(payload) {
  const prDetails = await getPRDetails(payload);
  let diff;
  // const eventData = JSON.parse(
  //   //readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  //  // readFileSync(GITHUB_EVENT_PATH ??"","utf8")
  // );
  const eventData=payload;

  if (eventData.action === "opened") {
    diff = await getDiff(

      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

webhooks.on("pull_request", async (event) => {
 // const webhookEvent = event.data;
 // const payload = webhookEvent;
  console.log("Received webhook event:", event);
main(event.payload).catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
});
