import chalk from "chalk";

export class Chalk {
  success(msg: unknown) {
    return chalk.greenBright(this.parseMessage(msg));
  }
  infoTitle(msg: unknown) {
    return chalk.hex("#61E8E1")(this.parseMessage(msg));
  }
  info(msg: unknown) {
    return chalk.blueBright(this.parseMessage(msg));
  }
  warn(msg: unknown) {
    return chalk.yellowBright(this.parseMessage(msg));
  }
  error(msg: unknown) {
    return chalk.redBright(this.parseMessage(msg));
  }
  promptMessage(msg: unknown) {
    return chalk.hex("#EEB868").bold(this.parseMessage(msg));
  }
  promptSelection(msg: unknown) {
    return chalk.hex("#31E981")(this.parseMessage(msg));
  }
  private parseMessage(msg: unknown) {
    switch (typeof msg) {
      case "object":
        return JSON.stringify(msg, null, 2);
      case "function":
        return msg.toString();
      default:
        return msg;
    }
  }
}
