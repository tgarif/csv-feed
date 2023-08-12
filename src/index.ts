import mqtt from "async-mqtt";
import { ColumnOption, Options, parse as parseCsv } from "csv-parse/sync";
import fs from "fs";
import glob from "glob-promise";
import { join, resolve } from "path";
import prompts from "prompts";

import { Chalk } from "./chalk";
import topics from "./topics.json";

enum Action {
  INPUT = "Manual Input",
  PATTERN = "String Match",
  SELECTION = "Choose from tags/fields",
}

interface TopicState {
  selectedTopic: string | null;
  topicKeyMapping: Array<{
    topicIndex: number;
    key: string;
  }>;
}

const appChalk = new Chalk();

async function convertRawRecords<
  T extends Array<Record<string, string | number | Date>>
>(records: T): Promise<T> {
  br();
  console.log(appChalk.infoTitle("First dataset:"));
  console.log(appChalk.info(records[0]));
  console.log(
    appChalk.info(
      "Note: time field will automatically be converted into js Date object"
    )
  );

  records.forEach((r) => (r.time = new Date(r.time)));

  const { answer } = await prompts({
    type: "select",
    name: "answer",
    message: appChalk.promptMessage(
      "Do you want to convert some records to Number?"
    ),
    choices: [
      { title: appChalk.promptSelection("Yes"), value: true },
      { title: appChalk.promptSelection("No"), value: false },
    ],
  });

  if (!answer) return records;

  const { selectedRecords } = await prompts({
    type: "multiselect",
    name: "selectedRecords",
    message: appChalk.promptMessage(
      "Select records that you wanted to convert to Number:"
    ),
    choices: [
      ...Object.keys(records[0])
        .filter((k) => k !== "time")
        .map((k) => ({
          title: appChalk.promptSelection(
            `"${k}": ${
              typeof records[0][k] === "string"
                ? `"${records[0][k]}"`
                : `${records[0][k]}`
            }`
          ),
          value: k,
        })),
    ],
    hint: "- Space to select. Return to submit",
    min: 1,
  });

  if (!selectedRecords) {
    br();
    console.error(appChalk.error("Cancelled...!"));
    br();
    process.exit(0);
  }

  records.forEach((r) => {
    for (const selectedKey of selectedRecords as string[]) {
      r[selectedKey] = Number(r[selectedKey]);
    }
  });

  console.log(appChalk.infoTitle("First dataset:"));
  console.log(appChalk.info(records[0]));

  return records;
}

async function modifyColumns(columns: string[]): Promise<string[]> {
  console.log(appChalk.infoTitle("Available Tags and Fields"));
  console.log(appChalk.info(columns));
  br();

  const { answer } = await prompts({
    type: "select",
    name: "answer",
    message: appChalk.promptMessage("Do you want to modify the tags/fields?"),
    choices: [
      { title: appChalk.promptSelection("Yes"), value: true },
      { title: appChalk.promptSelection("No"), value: false },
    ],
  });

  if (!answer) return columns;

  do {
    const { selectedAction } = await prompts({
      type: "select",
      name: "selectedAction",
      message: appChalk.promptMessage("Choose the action:"),
      choices: [
        {
          title: appChalk.promptSelection(Action.INPUT),
          value: Action.INPUT,
          description: "Rename tags/fields with inputted string.",
        },
        {
          title: appChalk.promptSelection(Action.PATTERN),
          value: Action.PATTERN,
          description:
            "Replace part of the tags/fields that matches the string.",
        },
        {
          title: appChalk.promptSelection("Done"),
          value: "done",
          description: "Continue to next step.",
        },
      ],
    });

    if (!selectedAction) {
      br();
      console.error(appChalk.error("Cancelled...!"));
      br();
      process.exit(0);
    }

    if (selectedAction === "done") {
      break;
    }

    const { selectedColumns } = await prompts({
      type: "multiselect",
      name: "selectedColumns",
      message: appChalk.promptMessage(
        "Select all tags/fields that you wanted to modify:"
      ),
      choices: [
        ...columns
          .map((c, i) => ({
            title: appChalk.promptSelection(c),
            value: { column: c, index: i },
          }))
          .filter((v) => v.value.column !== "time"),
      ],
      hint: "- Space to select. Return to submit",
      min: 1,
    });

    if (!selectedColumns) {
      br();
      console.error(appChalk.error("Cancelled...!"));
      br();
      process.exit(0);
    }

    br();
    console.log(appChalk.infoTitle("Selected Tags and Fields to rename:"));
    console.log(
      appChalk.info(
        (selectedColumns as Array<{ column: string; index: number }>).map(
          (v) => v.column
        )
      )
    );

    if (selectedAction === Action.INPUT) {
      for (const selected of selectedColumns as Array<{
        column: string;
        index: number;
      }>) {
        const { input } = await prompts({
          type: "text",
          name: "input",
          message: appChalk.promptMessage(
            `Enter string to replace [${columns[selected.index]}]:`
          ),
        });

        if (!input) continue;
        columns[selected.index] = input;
      }
    }

    if (selectedAction === Action.PATTERN) {
      const { pattern } = await prompts({
        type: "text",
        name: "pattern",
        message: appChalk.promptMessage(`Enter string to match:`),
      });

      if (!pattern) continue;

      const { replace } = await prompts({
        type: "text",
        name: "replace",
        message: appChalk.promptMessage(`Enter string to replace with:`),
      });

      for (const selected of selectedColumns as Array<{
        column: string;
        index: number;
      }>) {
        const replacer = new RegExp(
          (pattern as string).replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"),
          "g"
        );
        columns[selected.index] = columns[selected.index].replace(
          replacer,
          replace ?? ""
        );
      }
    }

    console.log(appChalk.infoTitle("Available Tags and Fields"));
    console.log(appChalk.info(columns));
  } while (true);

  return columns;
}

async function buildTopic(
  topics: Record<string, any>,
  record: Record<string, string | number | Date>
): Promise<TopicState> {
  const topicState: TopicState = {
    selectedTopic: null,
    topicKeyMapping: [],
  };

  let currentPrompt = JSON.parse(JSON.stringify(topics)) as Record<string, any>;

  do {
    const { answer } = await prompts({
      type: "select",
      name: "answer",
      message: appChalk.promptMessage("Select a topic:"),
      choices: [
        ...Object.keys(currentPrompt).map((k) => {
          if (typeof currentPrompt[k] === "string") {
            return {
              title: appChalk.promptSelection(`[${k}]: ${currentPrompt[k]}`),
              value: currentPrompt[k],
            };
          }

          return {
            title: appChalk.promptSelection(
              `${k} (${Object.keys(currentPrompt[k]).length})`
            ),
            value: currentPrompt[k],
          };
        }),
      ],
    });

    if (!answer) {
      br();
      console.error(appChalk.error("Cancelled...!"));
      br();
      process.exit(0);
    }

    if (typeof answer === "string") {
      topicState.selectedTopic = answer;
      break;
    }

    currentPrompt = answer;
  } while (true);

  const splittedTopic = topicState.selectedTopic.split("/");

  for (const [i, c] of splittedTopic.entries()) {
    if (!/^:/.test(c)) continue;

    br();
    console.log(appChalk.info(`Please replace ${c} from topic string`));
    br();

    const { answer } = await prompts({
      type: "select",
      name: "answer",
      message: appChalk.promptMessage("Select action:"),
      choices: [
        {
          title: appChalk.promptSelection(Action.INPUT),
          value: Action.INPUT,
          description: "Replace with inputted string.",
        },
        {
          title: appChalk.promptSelection(Action.SELECTION),
          value: Action.SELECTION,
          description:
            "Replace with selected tags/field (Note: selected tag/field will be removed from message sent to mqtt)",
        },
      ],
    });

    if (!answer) {
      br();
      console.error(appChalk.error("Cancelled...!"));
      br();
      process.exit(0);
    }

    if (answer === Action.INPUT) {
      const { input } = await prompts({
        type: "text",
        name: "input",
        message: appChalk.promptMessage(`Enter input to replace [${c}]:`),
      });

      if (!input) {
        br();
        console.error(appChalk.error("No input found...! Exiting."));
        br();
        process.exit(0);
      }

      splittedTopic[i] = input;
    }

    if (answer === Action.SELECTION) {
      const { selectedField } = await prompts({
        type: "select",
        name: "selectedField",
        message: appChalk.promptMessage(
          `Select a tag/field to replace [${c}]:`
        ),
        choices: [
          ...Object.keys(record)
            .filter((k) => k !== "time")
            .map((k) => ({
              title: appChalk.promptSelection(k),
              value: k,
            })),
        ],
        hint: "- Space to select. Return to submit",
      });

      if (!selectedField) {
        br();
        console.error(appChalk.error("No input selected...! Exiting."));
        br();
        process.exit(0);
      }

      topicState.topicKeyMapping.push({
        key: selectedField,
        topicIndex: i,
      });

      splittedTopic[i] = "+";
    }
  }

  topicState.selectedTopic = splittedTopic.join("/");

  return topicState;
}

function parse<T>(content: string | Buffer, options?: Options): T[] {
  return parseCsv(content, options);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function br() {
  console.log("\n");
}

(async () => {
  let parsedColumns: string[] = [];

  const csvFiles = (await glob(join(resolve("."), "data", "**/*.csv"))).map(
    (p) => ({ path: p, filename: p.split("/").slice(-1)[0] })
  );

  if (!csvFiles.length) {
    console.error(
      appChalk.error("No csv files found in 'data' directory! Exiting.")
    );
    br();
    process.exit(1);
  }

  const { answer } = await prompts({
    type: "select",
    name: "answer",
    message: appChalk.promptMessage("Pick a csv file"),
    choices: [
      ...csvFiles.map((p) => ({
        title: appChalk.promptSelection(p.filename),
        value: p.path,
      })),
    ],
  });

  if (!answer) {
    br();
    console.error(appChalk.warn("No csv file selected! Exiting."));
    br();
    process.exit();
  }

  br();
  console.log(appChalk.info(`Using input file at: '${answer}'`));
  br();

  const content = fs.readFileSync(answer);

  parse<void>(content, {
    delimiter: ",",
    columns: (columns: string[]): ColumnOption[] => {
      parsedColumns = columns;
      return columns;
    },
  });

  if (!parsedColumns.length) {
    br();
    console.error(appChalk.warn("Cannot parse selected csv! Exiting."));
    br();
    process.exit();
  }

  parsedColumns = await modifyColumns(parsedColumns);

  const records = (
    await convertRawRecords(
      parse<Record<string, string | number | Date>>(content, {
        delimiter: ",",
        columns() {
          return parsedColumns;
        },
        skip_empty_lines: true,
      })
    )
  ).sort((a, b) => (a.time as Date).getTime() - (b.time as Date).getTime());

  const client = await mqtt.connectAsync("mqtt://localhost:1883");

  br();
  console.log(appChalk.info("Topic builder"));
  br();

  const topicState = await buildTopic(
    topics as Record<string, any>,
    records[0]
  );

  if (topicState.selectedTopic === null) {
    br();
    console.error(appChalk.warn("No topic selected! Exiting."));
    br();
    process.exit();
  }

  const { seconds } = await prompts({
    type: "number",
    name: "seconds",
    message: appChalk.promptMessage("Enter publish interval in seconds:"),
    initial: 1,
    float: true,
    min: 1,
  });

  if (!seconds) {
    br();
    console.error(appChalk.warn("Cancelled!"));
    br();
    process.exit();
  }

  for (const message of records) {
    let topic = topicState.selectedTopic;

    if (topicState.topicKeyMapping.length) {
      const splittedTopic = topic.split("/");
      for (const keyMap of topicState.topicKeyMapping) {
        splittedTopic[keyMap.topicIndex] = String(message[keyMap.key]);
        delete message[keyMap.key];
      }
      topic = splittedTopic.join("/");
    }

    console.log(`[${message.time.toString()}]`, topic);
    await client.publish(topic, JSON.stringify(message), {
      retain: false,
      qos: 0,
    });
    await sleep(seconds * 1000);
  }

  await client.end();
})();
