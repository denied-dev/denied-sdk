"""Tests for shared action pattern extraction."""

from denied_sdk.integrations.shared import extract_action


class TestClaudeCodeBuiltInTools:
    """Test action extraction for Claude Code built-in tools."""

    def test_read_tools(self):
        """Test action extraction for read-only tools."""
        assert extract_action("Read") == "read"
        assert extract_action("Glob") == "read"
        assert extract_action("Grep") == "read"
        assert extract_action("WebFetch") == "read"
        assert extract_action("WebSearch") == "read"
        assert extract_action("ListMcpResourcesTool") == "read"
        assert extract_action("ReadMcpResourceTool") == "read"

    def test_create_tools(self):
        """Test action extraction for create/write tools."""
        assert extract_action("Write") == "create"

    def test_update_tools(self):
        """Test action extraction for update tools."""
        assert extract_action("Edit") == "update"
        assert extract_action("MultiEdit") == "update"
        assert extract_action("NotebookEdit") == "update"

    def test_execute_tools(self):
        """Test action extraction for execute tools."""
        assert extract_action("Bash") == "execute"
        assert extract_action("Task") == "execute"
        assert extract_action("TodoWrite") == "execute"
        assert extract_action("KillShell") == "execute"


class TestMCPToolPatterns:
    """Test action extraction for MCP tool naming patterns."""

    def test_read_patterns(self):
        """Test action extraction for read verb patterns."""
        assert extract_action("read_file") == "read"
        assert extract_action("get_user") == "read"
        assert extract_action("fetch_data") == "read"
        assert extract_action("list_items") == "read"
        assert extract_action("search_documents") == "read"
        assert extract_action("query_database") == "read"
        assert extract_action("retrieve_record") == "read"
        assert extract_action("load_config") == "read"

    def test_create_patterns(self):
        """Test action extraction for create verb patterns."""
        assert extract_action("write_file") == "create"
        assert extract_action("create_user") == "create"
        assert extract_action("add_item") == "create"
        assert extract_action("insert_record") == "create"
        assert extract_action("post_message") == "create"
        assert extract_action("save_document") == "create"
        assert extract_action("send_email") == "create"
        assert extract_action("upload_file") == "create"

    def test_update_patterns(self):
        """Test action extraction for update verb patterns."""
        assert extract_action("update_record") == "update"
        assert extract_action("modify_settings") == "update"
        assert extract_action("edit_document") == "update"
        assert extract_action("change_status") == "update"
        assert extract_action("set_value") == "update"
        assert extract_action("patch_resource") == "update"
        assert extract_action("rename_file") == "update"
        assert extract_action("mark_complete") == "update"

    def test_delete_patterns(self):
        """Test action extraction for delete verb patterns."""
        assert extract_action("delete_file") == "delete"
        assert extract_action("remove_user") == "delete"
        assert extract_action("drop_database") == "delete"
        assert extract_action("unshare_document") == "delete"

    def test_execute_patterns(self):
        """Test action extraction for execute verb patterns."""
        assert extract_action("execute_command") == "execute"
        assert extract_action("run_script") == "execute"
        assert extract_action("call_api") == "execute"
        assert extract_action("invoke_function") == "execute"
        assert extract_action("batch_process") == "execute"

    def test_special_operations(self):
        """Test action extraction for special operations."""
        # Share operations -> update
        assert extract_action("share_document") == "update"
        # Resource manipulation -> update
        assert extract_action("merge_branches") == "update"
        assert extract_action("fork_repo") == "update"
        assert extract_action("copy_file") == "update"
        assert extract_action("move_item") == "update"
        # State changes -> update
        assert extract_action("lock_resource") == "update"
        assert extract_action("unlock_resource") == "update"
        assert extract_action("restore_backup") == "update"


class TestCaseInsensitivity:
    """Test that action extraction is case-insensitive."""

    def test_uppercase_builtin_tools(self):
        """Test uppercase built-in tool names."""
        assert extract_action("READ") == "read"
        assert extract_action("WRITE") == "create"
        assert extract_action("EDIT") == "update"
        assert extract_action("BASH") == "execute"

    def test_lowercase_builtin_tools(self):
        """Test lowercase built-in tool names."""
        assert extract_action("read") == "read"
        assert extract_action("write") == "create"
        assert extract_action("edit") == "update"
        assert extract_action("bash") == "execute"

    def test_mixed_case_mcp_patterns(self):
        """Test mixed case MCP tool patterns."""
        assert extract_action("Get_User") == "read"
        assert extract_action("CREATE_ITEM") == "create"
        assert extract_action("Update_Record") == "update"


class TestDefaultAction:
    """Test default action for unknown patterns."""

    def test_unknown_patterns_default_to_execute(self):
        """Test that unknown patterns default to execute."""
        assert extract_action("calculate_total") == "execute"
        assert extract_action("process_data") == "execute"
        assert extract_action("unknown_tool") == "execute"
        assert extract_action("my_custom_tool") == "execute"
        assert extract_action("analyze") == "execute"
