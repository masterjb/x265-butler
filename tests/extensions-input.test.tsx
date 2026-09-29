import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExtensionsInput } from '@/components/settings/extensions-input';
import { wrap } from './test-utils';

describe('ExtensionsInput', () => {
  it('test_ExtensionsInput_when_comma_then_commits_chip', async () => {
    const onChange = vi.fn();
    render(wrap(<ExtensionsInput value={[]} onChange={onChange} />));
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'mp4,');
    expect(onChange).toHaveBeenLastCalledWith(['mp4']);
  });

  it('test_ExtensionsInput_when_enter_then_commits_chip', async () => {
    const onChange = vi.fn();
    render(wrap(<ExtensionsInput value={[]} onChange={onChange} />));
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'mkv{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['mkv']);
  });

  it('test_ExtensionsInput_when_backspace_on_empty_then_removes_last_chip', () => {
    const onChange = vi.fn();
    render(wrap(<ExtensionsInput value={['mp4', 'mkv']} onChange={onChange} />));
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['mp4']);
  });

  it('test_ExtensionsInput_when_remove_button_clicked_then_removes_that_chip', () => {
    const onChange = vi.fn();
    render(wrap(<ExtensionsInput value={['mp4', 'mkv']} onChange={onChange} />));
    const remove = screen.getByRole('button', { name: /remove mkv/i });
    fireEvent.click(remove);
    expect(onChange).toHaveBeenCalledWith(['mp4']);
  });

  it('test_ExtensionsInput_when_input_has_leading_dot_then_stripped_lowercased', async () => {
    const onChange = vi.fn();
    render(wrap(<ExtensionsInput value={[]} onChange={onChange} />));
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '.MP4{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['mp4']);
  });

  it('test_ExtensionsInput_when_duplicate_then_ignored', async () => {
    const onChange = vi.fn();
    render(wrap(<ExtensionsInput value={['mp4']} onChange={onChange} />));
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'mp4,');
    // last call (commit attempt) — onChange must NOT be called for the dup
    expect(onChange).not.toHaveBeenCalled();
  });
});
