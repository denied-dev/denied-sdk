import { describe, it, expect } from "vitest";
import { extractAction } from "./action-patterns";

describe("extractAction", () => {
  describe("Claude Code built-in tools", () => {
    it("should map Read tools to 'read'", () => {
      expect(extractAction("Read")).toBe("read");
      expect(extractAction("Glob")).toBe("read");
      expect(extractAction("Grep")).toBe("read");
      expect(extractAction("WebFetch")).toBe("read");
      expect(extractAction("WebSearch")).toBe("read");
      expect(extractAction("ListMcpResourcesTool")).toBe("read");
      expect(extractAction("ReadMcpResourceTool")).toBe("read");
    });

    it("should map Write tools to 'create'", () => {
      expect(extractAction("Write")).toBe("create");
      expect(extractAction("NotebookEdit")).toBe("create");
    });

    it("should map Edit tools to 'update'", () => {
      expect(extractAction("Edit")).toBe("update");
      expect(extractAction("MultiEdit")).toBe("update");
    });

    it("should map Execute tools to 'execute'", () => {
      expect(extractAction("Bash")).toBe("execute");
      expect(extractAction("Task")).toBe("execute");
      expect(extractAction("TodoWrite")).toBe("execute");
      expect(extractAction("KillShell")).toBe("execute");
    });
  });

  describe("MCP tool naming patterns", () => {
    it("should map read-like verbs to 'read'", () => {
      expect(extractAction("read_file")).toBe("read");
      expect(extractAction("get_user")).toBe("read");
      expect(extractAction("fetch_data")).toBe("read");
      expect(extractAction("load_config")).toBe("read");
      expect(extractAction("list_items")).toBe("read");
      expect(extractAction("search_documents")).toBe("read");
      expect(extractAction("query_database")).toBe("read");
      expect(extractAction("retrieve_record")).toBe("read");
    });

    it("should map create-like verbs to 'create'", () => {
      expect(extractAction("write_file")).toBe("create");
      expect(extractAction("create_user")).toBe("create");
      expect(extractAction("add_item")).toBe("create");
      expect(extractAction("insert_record")).toBe("create");
      expect(extractAction("post_message")).toBe("create");
      expect(extractAction("save_document")).toBe("create");
      expect(extractAction("send_email")).toBe("create");
      expect(extractAction("upload_file")).toBe("create");
    });

    it("should map update-like verbs to 'update'", () => {
      expect(extractAction("update_user")).toBe("update");
      expect(extractAction("modify_config")).toBe("update");
      expect(extractAction("edit_document")).toBe("update");
      expect(extractAction("change_settings")).toBe("update");
      expect(extractAction("set_value")).toBe("update");
      expect(extractAction("patch_record")).toBe("update");
      expect(extractAction("rename_file")).toBe("update");
      expect(extractAction("mark_complete")).toBe("update");
    });

    it("should map delete-like verbs to 'delete'", () => {
      expect(extractAction("delete_user")).toBe("delete");
      expect(extractAction("remove_item")).toBe("delete");
      expect(extractAction("drop_table")).toBe("delete");
      expect(extractAction("unshare_document")).toBe("delete");
    });

    it("should map special operations to 'update'", () => {
      expect(extractAction("share_document")).toBe("update");
      expect(extractAction("add_team_member")).toBe("update");
      expect(extractAction("merge_branches")).toBe("update");
      expect(extractAction("fork_repo")).toBe("update");
      expect(extractAction("copy_file")).toBe("update");
      expect(extractAction("move_item")).toBe("update");
      expect(extractAction("lock_resource")).toBe("update");
      expect(extractAction("unlock_resource")).toBe("update");
      expect(extractAction("restore_backup")).toBe("update");
    });

    it("should map execute-like verbs to 'execute'", () => {
      expect(extractAction("execute_query")).toBe("execute");
      expect(extractAction("run_script")).toBe("execute");
      expect(extractAction("call_api")).toBe("execute");
      expect(extractAction("invoke_function")).toBe("execute");
      expect(extractAction("batch_process")).toBe("execute");
    });
  });

  describe("default behavior", () => {
    it("should return 'execute' for unknown tool names", () => {
      expect(extractAction("unknown_tool")).toBe("execute");
      expect(extractAction("custom_operation")).toBe("execute");
      expect(extractAction("doSomething")).toBe("execute");
    });
  });

  describe("case insensitivity", () => {
    it("should be case insensitive for built-in tools", () => {
      expect(extractAction("read")).toBe("read");
      expect(extractAction("READ")).toBe("read");
      expect(extractAction("Read")).toBe("read");
    });

    it("should be case insensitive for MCP patterns", () => {
      expect(extractAction("GET_USER")).toBe("read");
      expect(extractAction("Create_Item")).toBe("create");
    });
  });
});
