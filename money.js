// Money: Keel's home screen. (Skeleton: the full screen arrives with the rest of the Money feature.)
export function startMoney({ root, onPhotos }) {
  root.innerHTML = `
    <div id="money">
      <div class="m-top"><a href="#" id="photos-link">Photos</a><b>Money</b><span></span></div>
      <p class="m-empty">Connect Up to see your money here.</p>
    </div>`;
  root.querySelector('#photos-link').addEventListener('click', e => { e.preventDefault(); onPhotos(); });
  return { async refresh() {} };
}
